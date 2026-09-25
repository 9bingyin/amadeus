package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/9bingyin/amadeus/internal/gateway"
	bot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

const (
	emptyReply               = "Agent 未返回文本。"
	newConversationReply     = "已开启新会话。"
	compactConversationReply = "当前会话已压缩。"
	statusConversationReply  = "已获取当前会话状态。"
	stopConversationReply    = "已停止当前任务。"
	nothingToStopReply       = "当前没有运行中的任务。"
	nothingToCompactReply    = "当前没有可压缩的会话历史。"
	commandUsageReply        = "该命令不接受参数。"
)

var telegramTokenPattern = regexp.MustCompile(`^[0-9]+:[A-Za-z0-9_-]+$`)

type Config struct {
	BotToken       string
	AllowedUserIDs []int64
	AttachmentsDir string
}

type waitFunc func(ctx context.Context, duration time.Duration) error
type saveFileFunc func(ctx context.Context, destPath, fileID string) error

type Service struct {
	bot            *bot.Bot
	handler        gateway.Handler
	wait           waitFunc
	saveFile       saveFileFunc
	attachmentsDir string
	fileHTTPClient *http.Client
	allowedUserIDs map[int64]struct{}
	fatalErrors    chan error
	fatal          atomic.Bool
	accountID      atomic.Int64
	botUsername    string
	tasks          sync.WaitGroup
	typingMu       sync.Mutex
	typings        map[typingKey]*sharedTyping
	deliveryMu     sync.Mutex
	deliveries     map[typingKey]chan struct{}
	progress       *progressBoard
	taskList       func(context.Context, string, string, string, string) (string, error)
}

type typingKey struct {
	chatID   int64
	threadID int
}

type sharedTyping struct {
	references int
	stop       func()
	refresh    func()
}

type deliverySlot struct {
	service  *Service
	key      typingKey
	previous <-chan struct{}
	done     chan struct{}
}

type gatewayCloser interface {
	Close()
}

type durableCommandReplies interface {
	UsesDurableCommandReplies()
}

type messageSender interface {
	SendChatAction(ctx context.Context, params *bot.SendChatActionParams) (bool, error)
	SendMessage(ctx context.Context, params *bot.SendMessageParams) (*models.Message, error)
}

func Validate(config Config) error {
	token := strings.TrimSpace(config.BotToken)
	if token == "" {
		return errors.New("telegram bot token is required")
	}
	if !telegramTokenPattern.MatchString(token) {
		return errors.New("telegram bot token has invalid format")
	}
	if len(config.AllowedUserIDs) == 0 {
		return errors.New("at least one Telegram allowed user ID is required")
	}
	for _, userID := range config.AllowedUserIDs {
		if userID <= 0 {
			return fmt.Errorf("invalid Telegram allowed user ID %d", userID)
		}
	}
	return nil
}

func New(config Config, handler gateway.Handler) (*Service, error) {
	return newService(config, handler)
}

func (s *Service) SetTaskList(list func(context.Context, string, string, string, string) (string, error)) {
	s.taskList = list
}

func newService(config Config, handler gateway.Handler, options ...bot.Option) (*Service, error) {
	if err := Validate(config); err != nil {
		return nil, err
	}
	if handler == nil {
		return nil, errors.New("telegram message handler is required")
	}

	token := strings.TrimSpace(config.BotToken)
	allowedUserIDs := make(map[int64]struct{}, len(config.AllowedUserIDs))
	for _, userID := range config.AllowedUserIDs {
		allowedUserIDs[userID] = struct{}{}
	}

	service := &Service{
		handler: handler,
		wait:    waitForRetry,
		fileHTTPClient: &http.Client{
			Transport: http.DefaultTransport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		allowedUserIDs: allowedUserIDs,
		fatalErrors:    make(chan error, 1),
		attachmentsDir: strings.TrimSpace(config.AttachmentsDir),
	}
	botOptions := []bot.Option{
		bot.WithSkipGetMe(),
		bot.WithDefaultHandler(service.handleUpdate),
		bot.WithAllowedUpdates(bot.AllowedUpdates{models.AllowedUpdateMessage}),
		bot.WithUpdatesChannelCap(0),
		bot.WithWorkers(1),
		bot.WithNotAsyncHandlers(),
		bot.WithErrorsHandler(service.handlePollingError),
	}
	botOptions = append(botOptions, options...)

	client, err := bot.New(token, botOptions...)
	if err != nil {
		return nil, fmt.Errorf("create Telegram bot: %w", err)
	}
	service.bot = client
	service.progress = &progressBoard{editor: client}
	service.saveFile = service.saveTelegramFile
	return service, nil
}

func (s *Service) Run(ctx context.Context) error {
	botUser, err := s.bot.GetMe(ctx)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		return fmt.Errorf("authenticate Telegram bot: %w", err)
	}
	s.accountID.Store(botUser.ID)
	s.botUsername = botUser.Username
	slog.DebugContext(ctx, "Authenticated Telegram bot", "bot", botUser)
	if _, err := s.bot.DeleteWebhook(ctx, &bot.DeleteWebhookParams{}); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		return fmt.Errorf("delete Telegram webhook: %w", err)
	}
	if _, err := s.bot.SetMyCommands(ctx, &bot.SetMyCommandsParams{
		Commands: []models.BotCommand{
			{Command: "new", Description: "开启新会话"},
			{Command: "compact", Description: "压缩当前会话"},
			{Command: "status", Description: "查看当前会话状态"},
			{Command: "stop", Description: "停止当前任务"},
			{Command: "schedule", Description: "查看定时任务"},
		},
		Scope: &models.BotCommandScopeAllPrivateChats{},
	}); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		return fmt.Errorf("register Telegram commands: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	if source, ok := s.handler.(replyQueue); ok {
		s.tasks.Go(func() {
			s.deliverReplies(runCtx, source, s.bot)
		})
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.bot.Start(runCtx)
	}()

	var fatalErr error
	select {
	case <-ctx.Done():
	case fatalErr = <-s.fatalErrors:
	case <-done:
	}
	cancel()
	<-done
	if closer, ok := s.handler.(gatewayCloser); ok {
		closer.Close()
	}
	s.tasks.Wait()

	if fatalErr == nil {
		select {
		case fatalErr = <-s.fatalErrors:
		default:
		}
	}
	if fatalErr != nil {
		return fmt.Errorf("run Telegram bot: %w", fatalErr)
	}
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return fmt.Errorf("run Telegram bot: %w", err)
	}
	return errors.New("telegram polling stopped unexpectedly")
}

func (s *Service) handlePollingError(err error) {
	if errors.Is(err, bot.ErrorUnauthorized) || errors.Is(err, bot.ErrorConflict) {
		s.signalFatal(err)
		return
	}
	slog.Error("Telegram polling error", "err", err)
}

func (s *Service) signalFatal(err error) {
	s.fatal.Store(true)
	select {
	case s.fatalErrors <- err:
	default:
	}
}

func (s *Service) handleUpdate(ctx context.Context, client *bot.Bot, update *models.Update) {
	slog.DebugContext(ctx, "Received Telegram update", "update", update)
	if s.fatal.Load() || update == nil || update.Message == nil {
		return
	}
	raw, err := json.Marshal(update)
	if err != nil {
		slog.ErrorContext(ctx, "Encode Telegram update", "err", err)
		return
	}
	source := ingressPayload{
		UpdateID: update.ID, MessageID: update.Message.ID, ChatID: update.Message.Chat.ID,
		ThreadID: update.Message.MessageThreadID, Raw: raw,
	}
	if err := s.handleMessageWithSource(ctx, client, update.Message, source); err != nil {
		if errors.Is(err, bot.ErrorUnauthorized) {
			s.signalFatal(err)
			return
		}
		if ctx.Err() != nil {
			slog.DebugContext(ctx, "Telegram message canceled", "err", err)
			return
		}
		slog.ErrorContext(ctx, "Handle Telegram message", "err", err)
	}
}

func (s *Service) handleMessage(ctx context.Context, sender messageSender, message *models.Message) error {
	if message == nil {
		return nil
	}
	raw, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("encode Telegram message: %w", err)
	}
	return s.handleMessageWithSource(ctx, sender, message, ingressPayload{
		MessageID: message.ID, ChatID: message.Chat.ID, ThreadID: message.MessageThreadID, Raw: raw,
	})
}

func (s *Service) handleMessageWithSource(
	ctx context.Context,
	sender messageSender,
	message *models.Message,
	source ingressPayload,
) error {
	if message == nil || message.From == nil || message.From.IsBot {
		return nil
	}
	if message.Chat.Type != models.ChatTypePrivate {
		return nil
	}
	if _, allowed := s.allowedUserIDs[message.From.ID]; !allowed {
		slog.Warn("Rejected Telegram user", "user_id", message.From.ID)
		return nil
	}

	commandText := strings.TrimSpace(message.Text)
	if commandText == "" {
		commandText = strings.TrimSpace(message.Caption)
	}
	if !hasInboundContent(message) {
		return nil
	}

	stopTyping := s.acquireTyping(ctx, sender, message)
	if command, hasArguments, ok := parseConversationCommand(commandText, s.botUsername); ok {
		return s.handleConversationCommand(ctx, sender, message, source, command, hasArguments, stopTyping)
	}
	if hasArguments, ok := parseScheduleCommand(commandText, s.botUsername); ok {
		return s.handleScheduleCommand(ctx, sender, message, hasArguments, stopTyping)
	}

	inbound, err := s.inbound(ctx, message)
	if err != nil {
		if ctx.Err() != nil {
			stopTyping()
			return ctx.Err()
		}
		if errors.Is(err, bot.ErrorUnauthorized) {
			stopTyping()
			return err
		}
		slog.Error("Prepare Telegram message", "err", err, "user_id", message.From.ID)
		return s.respondWithError(ctx, sender, message, err, stopTyping)
	}
	if inbound.Text == "" && len(inbound.Attachments) == 0 {
		stopTyping()
		return nil
	}

	accountID := strconv.FormatInt(s.accountID.Load(), 10)
	if s.accountID.Load() == 0 {
		accountID = "unknown"
	}
	sourceEventID := strconv.FormatInt(source.UpdateID, 10)
	if source.UpdateID == 0 {
		sourceEventID = strconv.FormatInt(message.Chat.ID, 10) + ":" + strconv.Itoa(message.ID)
	}
	sourcePayload, err := json.Marshal(source)
	if err != nil {
		stopTyping()
		return fmt.Errorf("encode Telegram ingress: %w", err)
	}
	threadID := ""
	if message.MessageThreadID != 0 {
		threadID = strconv.Itoa(message.MessageThreadID)
	}
	gatewayMessage := gateway.Message{
		Platform: "telegram", ConversationID: strconv.FormatInt(message.Chat.ID, 10),
		SenderID: strconv.FormatInt(message.From.ID, 10), Text: inbound.Text, Attachments: inbound.Attachments,
	}
	if _, persistent := s.handler.(interface{ UsesPersistentMessages() }); persistent {
		gatewayMessage.AccountID = accountID
		gatewayMessage.ThreadID = threadID
		gatewayMessage.SourceNamespace = "telegram:" + accountID
		gatewayMessage.SourceEventID = sourceEventID
		gatewayMessage.SourcePayload = sourcePayload
	}
	if submitter, ok := s.handler.(gateway.Submitter); ok {
		receipt, submitErr := submitter.Submit(ctx, gatewayMessage)
		if submitErr != nil {
			if ctx.Err() != nil {
				stopTyping()
				return ctx.Err()
			}
			slog.Error("Submit Telegram message", "err", submitErr, "user_id", message.From.ID)
			s.scheduleText(ctx, sender, message, submitErr.Error(), stopTyping)
			return nil
		}
		responseMessage := *message
		slot := s.reserveDelivery(&responseMessage)
		s.tasks.Go(func() {
			s.awaitReceipt(ctx, sender, &responseMessage, receipt, slot, stopTyping)
		})
		return nil
	}

	reply, err := s.handler.Handle(ctx, gatewayMessage)
	if err != nil {
		if ctx.Err() != nil {
			stopTyping()
			return ctx.Err()
		}
		slog.Error("Run Telegram agent", "err", err, "user_id", message.From.ID)
		stopTyping()
		return sendText(ctx, sender, message, err.Error(), s.wait)
	}
	if strings.TrimSpace(reply) == "" {
		reply = emptyReply
	}
	stopTyping()
	return sendText(ctx, sender, message, reply, s.wait)
}

func (s *Service) respondWithError(
	ctx context.Context,
	sender messageSender,
	message *models.Message,
	cause error,
	stopTyping func(),
) error {
	if _, ok := s.handler.(gateway.Submitter); ok {
		s.scheduleText(ctx, sender, message, cause.Error(), stopTyping)
		return nil
	}
	stopTyping()
	return sendText(ctx, sender, message, cause.Error(), s.wait)
}

func (s *Service) scheduleText(
	ctx context.Context,
	sender messageSender,
	message *models.Message,
	text string,
	stopTyping func(),
) {
	responseMessage := *message
	slot := s.reserveDelivery(&responseMessage)
	s.tasks.Go(func() {
		defer stopTyping()
		defer slot.complete()
		slot.wait()
		if ctx.Err() != nil {
			return
		}
		if err := sendText(ctx, sender, &responseMessage, text, s.wait); err != nil {
			s.handleAsyncSendError(ctx, err)
		}
	})
}

func (s *Service) awaitReceipt(
	ctx context.Context,
	sender messageSender,
	message *models.Message,
	receipt *gateway.Receipt,
	slot *deliverySlot,
	stopTyping func(),
) {
	defer stopTyping()
	defer slot.complete()

	// Wait for the run to observe service cancellation and finish before the
	// runtime closes shared tools. The original context still controls the run
	// and suppresses delivery during shutdown.
	result, err := receipt.Wait(context.WithoutCancel(ctx))
	slot.wait()
	if err != nil {
		if ctx.Err() != nil {
			slog.DebugContext(ctx, "Telegram agent response canceled", "err", err)
			return
		}
		if !result.Deliver {
			return
		}
		slog.ErrorContext(ctx, "Run Telegram agent", "err", err)
		if sendErr := sendText(ctx, sender, message, err.Error(), s.wait); sendErr != nil {
			s.handleAsyncSendError(ctx, sendErr)
		}
		return
	}
	if !result.Deliver {
		return
	}
	reply := result.Reply
	if strings.TrimSpace(reply) == "" {
		reply = emptyReply
	}
	if err := sendText(ctx, sender, message, reply, s.wait); err != nil {
		s.handleAsyncSendError(ctx, err)
	}
}

func (s *Service) reserveDelivery(message *models.Message) *deliverySlot {
	key := typingKey{chatID: message.Chat.ID, threadID: message.MessageThreadID}
	done := make(chan struct{})
	s.deliveryMu.Lock()
	if s.deliveries == nil {
		s.deliveries = make(map[typingKey]chan struct{})
	}
	slot := &deliverySlot{
		service:  s,
		key:      key,
		previous: s.deliveries[key],
		done:     done,
	}
	s.deliveries[key] = done
	s.deliveryMu.Unlock()
	return slot
}

func (s *deliverySlot) wait() {
	if s.previous != nil {
		<-s.previous
	}
}

func (s *deliverySlot) complete() {
	s.service.deliveryMu.Lock()
	if s.service.deliveries[s.key] == s.done {
		delete(s.service.deliveries, s.key)
	}
	s.service.deliveryMu.Unlock()
	close(s.done)
}

func (s *Service) handleAsyncSendError(ctx context.Context, err error) {
	if errors.Is(err, bot.ErrorUnauthorized) {
		s.signalFatal(err)
		return
	}
	if ctx.Err() != nil {
		slog.DebugContext(ctx, "Telegram response canceled", "err", err)
		return
	}
	slog.ErrorContext(ctx, "Send Telegram response", "err", err)
}
