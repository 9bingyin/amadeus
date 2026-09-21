package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation"
	tgbot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

type ingressPayload struct {
	UpdateID  int64           `json:"updateId"`
	MessageID int             `json:"messageId"`
	ChatID    int64           `json:"chatId"`
	ThreadID  int             `json:"threadId,omitempty"`
	Raw       json.RawMessage `json:"raw"`
}

type outboxPayload struct {
	ChatID           int64                  `json:"chatId"`
	ThreadID         int                    `json:"threadId,omitempty"`
	ReplyToMessageID int                    `json:"replyToMessageId,omitempty"`
	Text             string                 `json:"text"`
	Entities         []models.MessageEntity `json:"entities,omitempty"`
}

type outboxSource interface {
	OutboxReady() <-chan struct{}
	PendingOutbox(ctx context.Context, now time.Time) ([]conversation.PendingOutbox, error)
	NextOutboxAt(ctx context.Context) (time.Time, bool, error)
	StartDelivery(ctx context.Context, outboxID string) (int64, error)
	CompleteDelivery(ctx context.Context, outboxID string) error
	FailDelivery(ctx context.Context, outboxID, message string, retryAt time.Time, dead bool) error
}

func PlanOutbox(reply conversation.FinalReply) ([]conversation.OutboxChunk, error) {
	if reply.Route.Platform != "telegram" {
		return nil, fmt.Errorf("unsupported outbox platform %q", reply.Route.Platform)
	}
	chatID, err := strconv.ParseInt(reply.Route.ChatID, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("parse Telegram chat ID: %w", err)
	}
	threadID := 0
	if reply.Route.ThreadID != "" {
		threadID, err = strconv.Atoi(reply.Route.ThreadID)
		if err != nil {
			return nil, fmt.Errorf("parse Telegram thread ID: %w", err)
		}
	}
	var ingress ingressPayload
	if err := json.Unmarshal(reply.ReplySourcePayload, &ingress); err != nil {
		return nil, fmt.Errorf("decode Telegram ingress payload: %w", err)
	}
	text := reply.Text
	if reply.Kind == "error" {
		text = errorReply
	} else if strings.TrimSpace(text) == "" {
		text = emptyReply
	}
	formatted := formatTelegramReply(text)
	chunks := make([]conversation.OutboxChunk, 0, len(formatted))
	for _, chunk := range formatted {
		if strings.TrimSpace(chunk.Text) == "" {
			continue
		}
		payload, err := json.Marshal(outboxPayload{
			ChatID: chatID, ThreadID: threadID, ReplyToMessageID: ingress.MessageID,
			Text: chunk.Text, Entities: telegramEntities(chunk.Entities),
		})
		if err != nil {
			return nil, fmt.Errorf("encode Telegram outbox chunk: %w", err)
		}
		chunks = append(chunks, conversation.OutboxChunk{Kind: reply.Kind, Payload: payload})
	}
	if len(chunks) == 0 {
		return nil, errors.New("telegram outbox reply is empty")
	}
	return chunks, nil
}

func (s *Service) runOutbox(ctx context.Context, source outboxSource, sender messageSender) {
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		pending, err := source.PendingOutbox(ctx, time.Now())
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.ErrorContext(ctx, "Load Telegram outbox", "err", err)
			s.waitOutbox(ctx, source, time.Now().Add(time.Second))
			continue
		}
		if len(pending) == 0 {
			next, ok, nextErr := source.NextOutboxAt(ctx)
			if nextErr != nil {
				slog.ErrorContext(ctx, "Find next Telegram outbox message", "err", nextErr)
				s.waitOutbox(ctx, source, time.Now().Add(time.Second))
				continue
			}
			if !ok {
				next = time.Time{}
			}
			s.waitOutbox(ctx, source, next)
			continue
		}
		for _, item := range pending {
			if err := s.deliverOutbox(ctx, source, sender, item); err != nil {
				if ctx.Err() != nil {
					return
				}
				slog.ErrorContext(ctx, "Deliver Telegram outbox", "outbox_id", item.ID, "err", err)
			}
		}
	}
}

func (s *Service) waitOutbox(ctx context.Context, source outboxSource, retryAt time.Time) {
	if retryAt.IsZero() {
		select {
		case <-ctx.Done():
		case <-source.OutboxReady():
		}
		return
	}
	delay := max(time.Until(retryAt), 0)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-source.OutboxReady():
	case <-timer.C:
	}
}

func (s *Service) deliverOutbox(
	ctx context.Context,
	source outboxSource,
	sender messageSender,
	item conversation.PendingOutbox,
) error {
	attempt, err := source.StartDelivery(ctx, item.ID)
	if err != nil {
		return err
	}
	var payload outboxPayload
	if err := json.Unmarshal(item.Payload, &payload); err != nil {
		return errors.Join(err, source.FailDelivery(ctx, item.ID, err.Error(), time.Time{}, true))
	}
	params := &tgbot.SendMessageParams{
		ChatID: payload.ChatID, MessageThreadID: payload.ThreadID,
		Text: payload.Text, Entities: payload.Entities,
	}
	if item.ChunkIndex == 0 && payload.ReplyToMessageID != 0 {
		params.ReplyParameters = &models.ReplyParameters{
			MessageID: payload.ReplyToMessageID, AllowSendingWithoutReply: true,
		}
	}
	slog.DebugContext(ctx, "Sending Telegram outbox message", "outbox_id", item.ID, "request", params)
	_, err = sender.SendMessage(ctx, params)
	if err == nil {
		return s.finishOutboxDelivery(ctx, source, item)
	}
	if errors.Is(err, tgbot.ErrorBadRequest) && len(params.Entities) > 0 {
		fallback := *params
		fallback.Entities = nil
		if _, fallbackErr := sender.SendMessage(ctx, &fallback); fallbackErr == nil {
			return s.finishOutboxDelivery(ctx, source, item)
		} else {
			err = fallbackErr
		}
	}
	if errors.Is(err, tgbot.ErrorUnauthorized) {
		s.signalFatal(err)
		return err
	}
	retryAt, dead := deliveryRetry(err, attempt)
	if persistErr := source.FailDelivery(ctx, item.ID, err.Error(), retryAt, dead); persistErr != nil {
		return errors.Join(err, persistErr)
	}
	return err
}

func (s *Service) finishOutboxDelivery(
	ctx context.Context,
	source outboxSource,
	item conversation.PendingOutbox,
) error {
	if err := source.CompleteDelivery(ctx, item.ID); err != nil {
		return err
	}
	if s.progress != nil && item.RunID != "" && item.ChunkCount > 0 &&
		item.ChunkIndex == item.ChunkCount-1 && (item.Kind == "final" || item.Kind == "error") {
		s.progress.clear(ctx, item.RunID)
	}
	return nil
}

func deliveryRetry(err error, attempt int64) (time.Time, bool) {
	if rateLimit, ok := errors.AsType[*tgbot.TooManyRequestsError](err); ok && rateLimit.RetryAfter > 0 {
		return time.Now().Add(time.Duration(rateLimit.RetryAfter) * time.Second), false
	}
	if errors.Is(err, tgbot.ErrorBadRequest) || errors.Is(err, tgbot.ErrorForbidden) || errors.Is(err, tgbot.ErrorNotFound) {
		return time.Time{}, true
	}
	delay := time.Second
	for current := int64(1); current < attempt && delay < time.Minute; current++ {
		delay *= 2
	}
	if delay > time.Minute {
		delay = time.Minute
	}
	return time.Now().Add(delay), false
}
