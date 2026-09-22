package telegram

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	bot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

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
		params := &bot.SendMessageParams{
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
	params *bot.SendMessageParams,
	wait waitFunc,
) error {
	for {
		slog.DebugContext(ctx, "Sending Telegram message", "request", params)
		message, err := sender.SendMessage(ctx, params)
		if err != nil {
			if errors.Is(err, bot.ErrorBadRequest) && len(params.Entities) > 0 {
				slog.WarnContext(ctx, "Retrying Telegram message without rich text", "err", err)
				fallback := *params
				fallback.Entities = nil
				params = &fallback
				continue
			}
			rateLimit, ok := errors.AsType[*bot.TooManyRequestsError](err)
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
