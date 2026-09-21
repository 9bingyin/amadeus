package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/9bingyin/amadeus/internal/agent"
	tgbot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

const (
	progressLineRunes      = 60
	progressMaxLines       = 15
	compactionProgressText = "🗜️ Context compacting..."
)

type progressEditor interface {
	SendMessage(ctx context.Context, params *tgbot.SendMessageParams) (*models.Message, error)
	EditMessageText(ctx context.Context, params *tgbot.EditMessageTextParams) (*models.Message, error)
	DeleteMessage(ctx context.Context, params *tgbot.DeleteMessageParams) (bool, error)
}

type progressDraft struct {
	mu            sync.Mutex
	chatID        int64
	threadID      int
	messageID     int
	inputRevision int64
	lines         []string
	truncated     bool
	closed        bool
}

type compactionMessage struct {
	chatID    int64
	messageID int
}

type progressBoard struct {
	mu          sync.Mutex
	drafts      map[string]*progressDraft
	compactions map[string]compactionMessage
	editor      progressEditor
}

func (s *Service) ToolStarted(ctx context.Context, activity agent.ToolActivity) {
	if s == nil || s.progress == nil {
		return
	}
	s.progress.started(ctx, activity, s.continueTyping)
}

func (s *Service) ToolProgressReset(ctx context.Context, activity agent.ToolActivity) {
	if s == nil || s.progress == nil {
		return
	}
	s.progress.reset(ctx, activity)
}

func (s *Service) CompactionStarted(ctx context.Context, activity agent.CompactionActivity) {
	if s == nil || s.progress == nil {
		return
	}
	s.progress.showCompaction(ctx, activity, s.continueTyping)
}

func (s *Service) CompactionFinished(ctx context.Context, activity agent.CompactionActivity) {
	if s == nil || s.progress == nil {
		return
	}
	s.progress.hideCompaction(ctx, activity)
}

func (b *progressBoard) started(ctx context.Context, activity agent.ToolActivity, resume func(int64, int)) {
	if b == nil || b.editor == nil || activity.Platform != "telegram" || activity.RunID == "" {
		return
	}
	chatID, threadID, ok := progressRoute(activity.ChatID, activity.ThreadID)
	if !ok {
		return
	}
	draft := b.draft(activity.RunID, chatID, threadID)
	draft.mu.Lock()
	defer draft.mu.Unlock()
	if draft.closed || ctx.Err() != nil {
		return
	}
	staleID := 0
	if activity.InputRevision != 0 && draft.inputRevision > activity.InputRevision {
		return
	}
	if activity.InputRevision != 0 && draft.inputRevision != 0 && activity.InputRevision != draft.inputRevision {
		staleID = draft.messageID
		draft.messageID = 0
		draft.lines = nil
		draft.truncated = false
	}
	if activity.InputRevision != 0 {
		draft.inputRevision = activity.InputRevision
	}
	draft.add(formatToolProgressLine(activity.Name, activity.Input))
	text := draft.text()
	if draft.messageID == 0 {
		message, err := b.editor.SendMessage(ctx, &tgbot.SendMessageParams{
			ChatID: chatID, MessageThreadID: threadID, Text: text,
			DisableNotification: true, LinkPreviewOptions: disabledLinkPreview(),
		})
		if err != nil || message == nil {
			if err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "Send Telegram tool progress", "err", err, "chat_id", chatID)
			}
			b.deleteProgress(ctx, chatID, staleID)
			return
		}
		draft.messageID = message.ID
		if resume != nil {
			resume(chatID, threadID)
		}
		b.deleteProgress(ctx, chatID, staleID)
		return
	}
	_, err := b.editor.EditMessageText(ctx, &tgbot.EditMessageTextParams{
		ChatID: chatID, MessageID: draft.messageID, Text: text,
		LinkPreviewOptions: disabledLinkPreview(),
	})
	if err == nil || ctx.Err() != nil {
		return
	}
	if _, limited := errors.AsType[*tgbot.TooManyRequestsError](err); limited {
		slog.WarnContext(ctx, "Edit Telegram tool progress", "err", err, "chat_id", chatID)
		return
	}
	slog.WarnContext(ctx, "Edit Telegram tool progress", "err", err, "chat_id", chatID, "message_id", draft.messageID)
	message, sendErr := b.editor.SendMessage(ctx, &tgbot.SendMessageParams{
		ChatID: chatID, MessageThreadID: threadID, Text: text,
		DisableNotification: true, LinkPreviewOptions: disabledLinkPreview(),
	})
	if sendErr != nil || message == nil {
		if sendErr != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "Send Telegram tool progress", "err", sendErr, "chat_id", chatID)
		}
		return
	}
	oldID := draft.messageID
	draft.messageID = message.ID
	if resume != nil {
		resume(chatID, threadID)
	}
	if _, deleteErr := b.editor.DeleteMessage(ctx, &tgbot.DeleteMessageParams{
		ChatID: chatID, MessageID: oldID,
	}); deleteErr != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "Delete Telegram tool progress", "err", deleteErr, "chat_id", chatID, "message_id", oldID)
	}
}

func (b *progressBoard) reset(ctx context.Context, activity agent.ToolActivity) {
	if b == nil || b.editor == nil || activity.RunID == "" || activity.InputRevision == 0 {
		return
	}
	b.mu.Lock()
	draft := b.drafts[activity.RunID]
	b.mu.Unlock()
	if draft == nil {
		return
	}
	draft.mu.Lock()
	if draft.closed || activity.InputRevision <= draft.inputRevision {
		draft.mu.Unlock()
		return
	}
	draft.inputRevision = activity.InputRevision
	draft.lines = nil
	draft.truncated = false
	messageID := draft.messageID
	chatID := draft.chatID
	draft.messageID = 0
	draft.mu.Unlock()
	b.deleteProgress(ctx, chatID, messageID)
}

func (b *progressBoard) deleteProgress(ctx context.Context, chatID int64, messageID int) {
	if b == nil || b.editor == nil || messageID == 0 || ctx.Err() != nil {
		return
	}
	if _, err := b.editor.DeleteMessage(ctx, &tgbot.DeleteMessageParams{
		ChatID: chatID, MessageID: messageID,
	}); err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "Delete Telegram tool progress", "err", err, "chat_id", chatID, "message_id", messageID)
	}
}

func (b *progressBoard) showCompaction(
	ctx context.Context,
	activity agent.CompactionActivity,
	resume func(int64, int),
) {
	if b == nil || b.editor == nil || activity.Platform != "telegram" || activity.ChatID == "" {
		return
	}
	chatID, threadID, ok := progressRoute(activity.ChatID, activity.ThreadID)
	if !ok || ctx.Err() != nil {
		return
	}
	message, err := b.editor.SendMessage(ctx, &tgbot.SendMessageParams{
		ChatID: chatID, MessageThreadID: threadID, Text: compactionProgressText,
		DisableNotification: true, LinkPreviewOptions: disabledLinkPreview(),
	})
	if err != nil || message == nil {
		if err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "Send Telegram compaction progress", "err", err, "chat_id", chatID)
		}
		return
	}
	key := compactionKey(activity)
	b.mu.Lock()
	if b.compactions == nil {
		b.compactions = map[string]compactionMessage{}
	}
	previous := b.compactions[key]
	b.compactions[key] = compactionMessage{chatID: chatID, messageID: message.ID}
	b.mu.Unlock()
	if previous.messageID != 0 && previous.messageID != message.ID {
		if _, deleteErr := b.editor.DeleteMessage(ctx, &tgbot.DeleteMessageParams{
			ChatID: previous.chatID, MessageID: previous.messageID,
		}); deleteErr != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "Delete Telegram compaction progress", "err", deleteErr, "chat_id", previous.chatID)
		}
	}
	if resume != nil {
		resume(chatID, threadID)
	}
}

func (b *progressBoard) hideCompaction(ctx context.Context, activity agent.CompactionActivity) {
	if b == nil || b.editor == nil {
		return
	}
	key := compactionKey(activity)
	b.mu.Lock()
	note, ok := b.compactions[key]
	delete(b.compactions, key)
	b.mu.Unlock()
	if !ok || note.messageID == 0 || ctx.Err() != nil {
		return
	}
	if _, err := b.editor.DeleteMessage(ctx, &tgbot.DeleteMessageParams{
		ChatID: note.chatID, MessageID: note.messageID,
	}); err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "Delete Telegram compaction progress", "err", err, "chat_id", note.chatID, "message_id", note.messageID)
	}
}

func compactionKey(activity agent.CompactionActivity) string {
	if activity.RunID != "" {
		return "run\x00" + activity.RunID
	}
	return activity.Platform + "\x00" + activity.ChatID + "\x00" + activity.ThreadID
}

func progressRoute(chatIDText, threadIDText string) (int64, int, bool) {
	chatID, err := strconv.ParseInt(chatIDText, 10, 64)
	if err != nil || chatID == 0 {
		return 0, 0, false
	}
	threadID := 0
	if threadIDText != "" {
		threadID, err = strconv.Atoi(threadIDText)
		if err != nil {
			return 0, 0, false
		}
	}
	return chatID, threadID, true
}

func (b *progressBoard) draft(runID string, chatID int64, threadID int) *progressDraft {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.drafts == nil {
		b.drafts = map[string]*progressDraft{}
	}
	draft := b.drafts[runID]
	if draft == nil {
		draft = &progressDraft{chatID: chatID, threadID: threadID}
		b.drafts[runID] = draft
	}
	return draft
}

func (b *progressBoard) clear(ctx context.Context, runID string) {
	if b == nil || runID == "" {
		return
	}
	b.mu.Lock()
	draft := b.drafts[runID]
	delete(b.drafts, runID)
	b.mu.Unlock()
	if draft == nil {
		return
	}
	draft.mu.Lock()
	defer draft.mu.Unlock()
	draft.closed = true
	messageID := draft.messageID
	chatID := draft.chatID
	draft.messageID = 0
	if messageID == 0 || b.editor == nil || ctx.Err() != nil {
		return
	}
	if _, err := b.editor.DeleteMessage(ctx, &tgbot.DeleteMessageParams{
		ChatID: chatID, MessageID: messageID,
	}); err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "Delete Telegram tool progress", "err", err, "chat_id", chatID, "message_id", messageID)
	}
}

func (d *progressDraft) add(line string) {
	d.lines = append(d.lines, line)
	if len(d.lines) > progressMaxLines {
		d.lines = append([]string(nil), d.lines[len(d.lines)-progressMaxLines:]...)
		d.truncated = true
	}
}

func (d *progressDraft) text() string {
	lines := d.lines
	if d.truncated {
		lines = append([]string{"…"}, lines...)
	}
	return strings.Join(lines, "\n")
}

func formatToolProgressLine(name string, input any) string {
	switch name {
	case "bash":
		return progressLabel("🛠️ Bash", progressString(input, "command"))
	case "read":
		return progressLabel("📖 Read", progressString(input, "path"))
	case "write":
		return progressLabel("✍️ Write", progressString(input, "path"))
	case "edit":
		return progressLabel("📝 Edit", progressString(input, "path"))
	default:
		title := progressTitle(name)
		if title == "" {
			title = "Tool"
		}
		return progressLabel("🛠️ "+title, progressDetail(input))
	}
}

func progressLabel(label, detail string) string {
	text := label
	if detail != "" {
		text += ": " + detail
	}
	return limitRunes(text, progressLineRunes)
}

func progressTitle(name string) string {
	fields := strings.Fields(strings.ReplaceAll(name, "_", " "))
	for index, field := range fields {
		runes := []rune(field)
		if len(runes) == 0 {
			continue
		}
		if len(runes) <= 2 && field == strings.ToUpper(field) {
			continue
		}
		runes[0] = unicode.ToUpper(runes[0])
		fields[index] = string(runes)
	}
	return strings.Join(fields, " ")
}

func progressDetail(input any) string {
	for _, key := range []string{"query", "q", "text", "url", "path", "name", "prompt", "command"} {
		if detail := progressString(input, key); detail != "" {
			return detail
		}
	}
	return ""
}

func progressString(input any, key string) string {
	values := progressInput(input)
	if values == nil {
		return ""
	}
	text, ok := values[key].(string)
	if !ok {
		return ""
	}
	return strings.Join(strings.Fields(text), " ")
}

func progressInput(input any) map[string]any {
	switch value := input.(type) {
	case map[string]any:
		return value
	case json.RawMessage:
		var decoded map[string]any
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil
		}
		return decoded
	default:
		return nil
	}
}

func limitRunes(text string, maxRunes int) string {
	if utf8.RuneCountInString(text) <= maxRunes {
		return text
	}
	if maxRunes <= 1 {
		return "…"
	}
	runes := []rune(text)
	return string(runes[:maxRunes-1]) + "…"
}

func disabledLinkPreview() *models.LinkPreviewOptions {
	disabled := true
	return &models.LinkPreviewOptions{IsDisabled: &disabled}
}
