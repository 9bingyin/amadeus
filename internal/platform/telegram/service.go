package telegram

import (
	"context"
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
	slog.DebugContext(ctx, "Authenticated Telegram bot", "bot", botUser)
	if _, err := s.bot.DeleteWebhook(ctx, &tgbot.DeleteWebhookParams{}); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		return fmt.Errorf("delete Telegram webhook: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
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
	if err := s.handleMessage(ctx, client, update.Message); err != nil {
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

	stopTyping := startTyping(ctx, sender, message)
	defer stopTyping()

	attachments, err := s.attachments(ctx, message)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, tgbot.ErrorUnauthorized) {
			return err
		}
		slog.Error("Download Telegram attachment", "err", err, "user_id", message.From.ID)
		stopTyping()
		return sendText(ctx, sender, message, errorReply, s.wait)
	}
	if text == "" && len(attachments) == 0 {
		return nil
	}

	reply, err := s.handler.Handle(ctx, gateway.Message{
		Platform:       "telegram",
		ConversationID: strconv.FormatInt(message.Chat.ID, 10),
		SenderID:       strconv.FormatInt(message.From.ID, 10),
		Text:           text,
		Attachments:    attachments,
	})
	if err != nil {
		if ctx.Err() != nil {
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
