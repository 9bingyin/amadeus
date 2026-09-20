package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/9bingyin/amadeus/internal/gateway"
	tgbot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

const (
	typingRefreshInterval = 4 * time.Second
	errorReply            = "处理失败，请稍后重试。"
	emptyReply            = "Agent 未返回文本。"
)

var telegramTokenPattern = regexp.MustCompile(`^[0-9]+:[A-Za-z0-9_-]+$`)

type Config struct {
	BotToken       string
	AllowedUserIDs []int64
}

type waitFunc func(ctx context.Context, duration time.Duration) error
type downloadFileFunc func(ctx context.Context, fileID string) (data []byte, filePath string, err error)

type Service struct {
	bot            *tgbot.Bot
	handler        gateway.Handler
	wait           waitFunc
	downloadFile   downloadFileFunc
	fileHTTPClient *http.Client
	allowedUserIDs map[int64]struct{}
	fatalErrors    chan error
	fatal          atomic.Bool
	accountID      atomic.Int64
	tasks          sync.WaitGroup
	typingMu       sync.Mutex
	typings        map[typingKey]*sharedTyping
	deliveryMu     sync.Mutex
	deliveries     map[typingKey]chan struct{}
}

type typingKey struct {
	chatID   int64
	threadID int
}

type sharedTyping struct {
	references int
	stop       func()
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

type messageSender interface {
	SendChatAction(ctx context.Context, params *tgbot.SendChatActionParams) (bool, error)
	SendMessage(ctx context.Context, params *tgbot.SendMessageParams) (*models.Message, error)
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

func newService(config Config, handler gateway.Handler, options ...tgbot.Option) (*Service, error) {
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
	}
	botOptions := []tgbot.Option{
		tgbot.WithSkipGetMe(),
		tgbot.WithDefaultHandler(service.handleUpdate),
		tgbot.WithAllowedUpdates(tgbot.AllowedUpdates{models.AllowedUpdateMessage}),
		tgbot.WithUpdatesChannelCap(0),
		tgbot.WithWorkers(1),
		tgbot.WithNotAsyncHandlers(),
		tgbot.WithErrorsHandler(service.handlePollingError),
	}
	botOptions = append(botOptions, options...)

	client, err := tgbot.New(token, botOptions...)
	if err != nil {
		return nil, fmt.Errorf("create Telegram bot: %w", err)
	}
	service.bot = client
	service.downloadFile = service.downloadTelegramFile
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
	slog.DebugContext(ctx, "Authenticated Telegram bot", "bot", botUser)
	if _, err := s.bot.DeleteWebhook(ctx, &tgbot.DeleteWebhookParams{}); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		return fmt.Errorf("delete Telegram webhook: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	if source, ok := s.handler.(outboxSource); ok {
		s.tasks.Go(func() {
			s.runOutbox(runCtx, source, s.bot)
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
	if errors.Is(err, tgbot.ErrorUnauthorized) || errors.Is(err, tgbot.ErrorConflict) {
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

func (s *Service) handleUpdate(ctx context.Context, client *tgbot.Bot, update *models.Update) {
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
		if errors.Is(err, tgbot.ErrorUnauthorized) {
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

	text := strings.TrimSpace(message.Text)
	if text == "" {
		text = strings.TrimSpace(message.Caption)
	}
	if text == "" && len(message.Photo) == 0 && message.Document == nil {
		return nil
	}

	stopTyping := s.acquireTyping(ctx, sender, message)

	attachments, err := s.attachments(ctx, message)
	if err != nil {
		if ctx.Err() != nil {
			stopTyping()
			return ctx.Err()
		}
		if errors.Is(err, tgbot.ErrorUnauthorized) {
			stopTyping()
			return err
		}
		slog.Error("Download Telegram attachment", "err", err, "user_id", message.From.ID)
		return s.respondWithError(ctx, sender, message, stopTyping)
	}
	if text == "" && len(attachments) == 0 {
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
		SenderID: strconv.FormatInt(message.From.ID, 10), Text: text, Attachments: attachments,
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
			s.scheduleText(ctx, sender, message, errorReply, stopTyping)
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
		return sendText(ctx, sender, message, errorReply, s.wait)
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
	stopTyping func(),
) error {
	if _, ok := s.handler.(gateway.Submitter); ok {
		s.scheduleText(ctx, sender, message, errorReply, stopTyping)
		return nil
	}
	stopTyping()
	return sendText(ctx, sender, message, errorReply, s.wait)
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
		if sendErr := sendText(ctx, sender, message, errorReply, s.wait); sendErr != nil {
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
	if errors.Is(err, tgbot.ErrorUnauthorized) {
		s.signalFatal(err)
		return
	}
	if ctx.Err() != nil {
		slog.DebugContext(ctx, "Telegram response canceled", "err", err)
		return
	}
	slog.ErrorContext(ctx, "Send Telegram response", "err", err)
}

func (s *Service) acquireTyping(ctx context.Context, sender messageSender, message *models.Message) func() {
	key := typingKey{chatID: message.Chat.ID, threadID: message.MessageThreadID}
	s.typingMu.Lock()
	state := s.typings[key]
	if state == nil {
		if s.typings == nil {
			s.typings = make(map[typingKey]*sharedTyping)
		}
		state = &sharedTyping{references: 1, stop: startTyping(ctx, sender, message)}
		s.typings[key] = state
	} else {
		state.references++
	}
	s.typingMu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			s.releaseTyping(key, state)
		})
	}
}

func (s *Service) releaseTyping(key typingKey, expected *sharedTyping) {
	s.typingMu.Lock()
	state := s.typings[key]
	if state != expected {
		s.typingMu.Unlock()
		return
	}
	state.references--
	if state.references > 0 {
		s.typingMu.Unlock()
		return
	}
	delete(s.typings, key)
	stop := state.stop
	s.typingMu.Unlock()
	stop()
}

func startTyping(ctx context.Context, sender messageSender, message *models.Message) func() {
	typingCtx, cancel := context.WithCancel(ctx)
	params := &tgbot.SendChatActionParams{
		ChatID:          message.Chat.ID,
		MessageThreadID: message.MessageThreadID,
		Action:          models.ChatActionTyping,
	}
	sendTyping(typingCtx, sender, params)

	ticker := time.NewTicker(typingRefreshInterval)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer ticker.Stop()
		refreshTyping(typingCtx, sender, params, ticker.C)
	}()

	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
}

func refreshTyping(
	ctx context.Context,
	sender messageSender,
	params *tgbot.SendChatActionParams,
	ticks <-chan time.Time,
) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			sendTyping(ctx, sender, params)
		}
	}
}

func sendTyping(ctx context.Context, sender messageSender, params *tgbot.SendChatActionParams) {
	slog.DebugContext(ctx, "Sending Telegram chat action", "request", params)
	sent, err := sender.SendChatAction(ctx, params)
	if err != nil {
		if ctx.Err() != nil {
			slog.DebugContext(ctx, "Telegram chat action canceled", "err", err)
			return
		}
		slog.WarnContext(ctx, "Send Telegram chat action", "err", err)
		return
	}
	if !sent {
		slog.WarnContext(ctx, "Telegram chat action was not accepted", "request", params)
	}
}

func (s *Service) attachments(ctx context.Context, message *models.Message) ([]gateway.Attachment, error) {
	if len(message.Photo) > 0 {
		photo := largestPhoto(message.Photo)
		data, _, err := s.downloadFile(ctx, photo.FileID)
		if err != nil {
			return nil, err
		}
		return []gateway.Attachment{{
			Kind: gateway.AttachmentKindImage, Data: data, MediaType: "image/jpeg", Filename: "photo.jpg",
		}}, nil
	}
	if message.Document == nil {
		return nil, nil
	}

	document := message.Document
	data, filePath, err := s.downloadFile(ctx, document.FileID)
	if err != nil {
		return nil, err
	}
	filename := strings.TrimSpace(document.FileName)
	if filename == "" {
		filename = path.Base(filePath)
		if filename == "." || filename == "/" || filename == "" {
			filename = "attachment"
		}
	}
	mediaType := strings.TrimSpace(document.MimeType)
	if mediaType == "" || strings.EqualFold(mediaType, "application/octet-stream") {
		mediaType = mime.TypeByExtension(path.Ext(filename))
		if mediaType == "" {
			mediaType = http.DetectContentType(data)
		}
	}
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	kind := gateway.AttachmentKindFile
	if strings.HasPrefix(strings.ToLower(mediaType), "image/") {
		kind = gateway.AttachmentKindImage
	}
	return []gateway.Attachment{{
		Kind: kind, Data: data, MediaType: mediaType, Filename: filename,
	}}, nil
}

func largestPhoto(photos []models.PhotoSize) models.PhotoSize {
	largest := photos[0]
	for _, photo := range photos[1:] {
		if photo.FileSize > largest.FileSize || photo.FileSize == largest.FileSize &&
			int64(photo.Width)*int64(photo.Height) > int64(largest.Width)*int64(largest.Height) {
			largest = photo
		}
	}
	return largest
}

func (s *Service) downloadTelegramFile(
	ctx context.Context,
	fileID string,
) (data []byte, filePath string, returnErr error) {
	file, err := s.bot.GetFile(ctx, &tgbot.GetFileParams{FileID: fileID})
	if err != nil {
		return nil, "", fmt.Errorf("get Telegram file: %w", err)
	}
	if strings.TrimSpace(file.FilePath) == "" {
		return nil, "", errors.New("telegram file path is empty")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.bot.FileDownloadLink(file), http.NoBody)
	if err != nil {
		return nil, "", errors.New("create Telegram file request")
	}
	response, err := s.fileHTTPClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", errors.New("download Telegram file request failed")
	}
	defer func() {
		returnErr = errors.Join(returnErr, response.Body.Close())
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", fmt.Errorf("download Telegram file: HTTP status %d", response.StatusCode)
	}
	data, err = io.ReadAll(response.Body)
	if err != nil {
		return nil, "", fmt.Errorf("read Telegram file: %w", err)
	}
	slog.DebugContext(ctx, "Downloaded Telegram file", "file", file, "data", data)
	return data, file.FilePath, nil
}

func sendText(
	ctx context.Context,
	sender messageSender,
	message *models.Message,
	text string,
	wait waitFunc,
) error {
	chunks := formatTelegramReply(text)
	hasText := false
	for _, chunk := range chunks {
		if strings.TrimSpace(chunk.Text) != "" {
			hasText = true
			break
		}
	}
	if !hasText {
		chunks = formatTelegramReply(emptyReply)
	}

	sent := false
	for _, chunk := range chunks {
		if strings.TrimSpace(chunk.Text) == "" {
			continue
		}
		params := &tgbot.SendMessageParams{
			ChatID:          message.Chat.ID,
			MessageThreadID: message.MessageThreadID,
			Text:            chunk.Text,
			Entities:        telegramEntities(chunk.Entities),
		}
		if !sent {
			params.ReplyParameters = &models.ReplyParameters{
				MessageID:                message.ID,
				AllowSendingWithoutReply: true,
			}
		}
		if err := sendChunk(ctx, sender, params, wait); err != nil {
			return err
		}
		sent = true
	}
	return nil
}

func sendChunk(
	ctx context.Context,
	sender messageSender,
	params *tgbot.SendMessageParams,
	wait waitFunc,
) error {
	for {
		slog.DebugContext(ctx, "Sending Telegram message", "request", params)
		message, err := sender.SendMessage(ctx, params)
		if err != nil {
			if errors.Is(err, tgbot.ErrorBadRequest) && len(params.Entities) > 0 {
				slog.WarnContext(ctx, "Retrying Telegram message without rich text", "err", err)
				fallback := *params
				fallback.Entities = nil
				params = &fallback
				continue
			}
			rateLimit, ok := errors.AsType[*tgbot.TooManyRequestsError](err)
			if !ok || rateLimit.RetryAfter < 1 {
				return fmt.Errorf("send Telegram message: %w", err)
			}
			if err := wait(ctx, time.Duration(rateLimit.RetryAfter)*time.Second); err != nil {
				return fmt.Errorf("wait to retry Telegram message: %w", err)
			}
			continue
		}
		slog.DebugContext(ctx, "Sent Telegram message", "request", params, "response", message)
		return nil
	}
}

func waitForRetry(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
