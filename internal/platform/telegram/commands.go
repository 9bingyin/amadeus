package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/9bingyin/amadeus/internal/gateway"
	"github.com/go-telegram/bot/models"
)

func parseConversationCommand(text, botUsername string) (command string, hasArguments, ok bool) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return "", false, false
	}
	token := strings.ToLower(fields[0])
	if !strings.HasPrefix(token, "/") {
		return "", false, false
	}
	token = strings.TrimPrefix(token, "/")
	name, mention, mentioned := strings.Cut(token, "@")
	if mentioned && !strings.EqualFold(mention, botUsername) {
		return "", false, false
	}
	if name != "new" && name != "compact" && name != "status" {
		return "", false, false
	}
	return name, len(fields) > 1, true
}

func formatConversationStatus(status gateway.ConversationStatus) string {
	reasoning := strings.TrimSpace(status.ReasoningEffort)
	if reasoning == "" {
		reasoning = "默认"
	}
	text := fmt.Sprintf(
		"会话 ID：%s\n模型：%s/%s\n推理强度：%s\n上下文：%s / %s tokens\n%s",
		status.SessionID,
		status.Provider,
		status.Model,
		reasoning,
		formatTokenCount(status.EstimatedContextTokens),
		formatTokenCount(status.ContextWindowTokens),
		formatCacheRate(status.CachedInputTokens, status.InputTokens),
	)
	if status.Embedding != nil {
		text += "\n" + formatEmbedding(*status.Embedding)
	}
	return text
}

func formatEmbedding(progress gateway.EmbeddingProgress) string {
	return fmt.Sprintf(
		"嵌入：%s/%s （%s）",
		formatTokenCount(progress.Done),
		formatTokenCount(progress.Total),
		embeddingLabel(progress.Done, progress.Total, progress.Phase),
	)
}

func embeddingLabel(done, total int, phase gateway.EmbeddingPhase) string {
	if phase == gateway.EmbeddingRebuilding {
		return "重建中"
	}
	if done < total {
		if phase == gateway.EmbeddingWaiting {
			return "等待重试"
		}
		return "嵌入中"
	}
	return "已完成"
}

func formatCacheRate(cached, input int) string {
	if input <= 0 {
		return "缓存率：—"
	}
	if cached < 0 {
		cached = 0
	}
	tenths := cached * 1000 / input
	return fmt.Sprintf(
		"缓存率：%d.%d%%（%s / %s tokens）",
		tenths/10, tenths%10,
		formatTokenCount(cached), formatTokenCount(input),
	)
}

func formatTokenCount(value int) string {
	text := strconv.Itoa(value)
	start := 0
	if strings.HasPrefix(text, "-") {
		start = 1
	}
	for index := len(text) - 3; index > start; index -= 3 {
		text = text[:index] + "," + text[index:]
	}
	return text
}

func (s *Service) handleConversationCommand(
	ctx context.Context,
	sender messageSender,
	message *models.Message,
	source ingressPayload,
	command string,
	hasArguments bool,
	stopTyping func(),
) error {
	if hasArguments {
		s.scheduleText(ctx, sender, message, commandUsageReply, stopTyping)
		return nil
	}
	commander, ok := s.handler.(gateway.ConversationCommander)
	if !ok {
		slog.ErrorContext(ctx, "Conversation commands are unavailable", "command", command)
		s.scheduleText(ctx, sender, message, "conversation commands are unavailable", stopTyping)
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
	threadID := ""
	if message.MessageThreadID != 0 {
		threadID = strconv.Itoa(message.MessageThreadID)
	}
	sourcePayload, err := json.Marshal(source)
	if err != nil {
		stopTyping()
		return fmt.Errorf("encode Telegram command ingress: %w", err)
	}
	reference := gateway.ConversationReference{
		Platform: "telegram", AccountID: accountID,
		ConversationID: strconv.FormatInt(message.Chat.ID, 10), ThreadID: threadID,
		SourceNamespace: "telegram:" + accountID, SourceEventID: sourceEventID,
		SourcePayload: sourcePayload, SuccessReply: newConversationReply,
		EmptyReply:   nothingToCompactReply,
		FormatStatus: formatConversationStatus,
	}
	var commandErr error
	reply := newConversationReply
	switch command {
	case "compact":
		reply = compactConversationReply
		reference.SuccessReply = compactConversationReply
		commandErr = commander.CompactConversation(ctx, reference)
	case "status":
		reply = statusConversationReply
		commandErr = commander.StatusConversation(ctx, reference)
	default:
		commandErr = commander.NewConversation(ctx, reference)
	}
	if errors.Is(commandErr, gateway.ErrConversationMissing) ||
		errors.Is(commandErr, gateway.ErrConversationNotCompactable) {
		reply = nothingToCompactReply
		commandErr = nil
	}
	if commandErr != nil {
		if ctx.Err() != nil {
			stopTyping()
			return ctx.Err()
		}
		slog.ErrorContext(ctx, "Execute Telegram conversation command", "command", command, "err", commandErr)
		reply = commandErr.Error()
	}
	if commandErr == nil {
		if _, durable := s.handler.(durableCommandReplies); durable {
			stopTyping()
			return nil
		}
	}
	s.scheduleText(ctx, sender, message, reply, stopTyping)
	return nil
}
