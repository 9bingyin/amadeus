package telegram

import (
	"context"
	"strings"
	"testing"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	bot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

func TestFormatToolProgressLine(t *testing.T) {
	tests := []struct {
		name  string
		tool  string
		input any
		want  string
	}{
		{name: "bash", tool: "bash", input: map[string]any{"command": "curl ip.sb"}, want: "🛠️ Bash: curl ip.sb"},
		{name: "read", tool: "read", input: map[string]any{"path": "../../file"}, want: "📖 Read: ../../file"},
		{name: "write", tool: "write", input: map[string]any{"path": "/path/file"}, want: "✍️ Write: /path/file"},
		{name: "edit", tool: "edit", input: map[string]any{"path": "../file"}, want: "📝 Edit: ../file"},
		{
			name:  "mcp",
			tool:  "exa__web_search",
			input: map[string]any{"query": "amadeus"},
			want:  "🛠️ Exa Web Search: amadeus",
		},
		{name: "mcp without detail", tool: "files__list", input: map[string]any{}, want: "🛠️ Files List"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := formatToolProgressLine(test.tool, test.input); got != test.want {
				t.Fatalf("formatToolProgressLine() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestFormatToolProgressLineTruncates(t *testing.T) {
	line := formatToolProgressLine("read", map[string]any{"path": strings.Repeat("a", 80)})
	if !strings.HasSuffix(line, "…") || len([]rune(line)) != progressLineRunes {
		t.Fatalf("line = %q (%d runes)", line, len([]rune(line)))
	}
}

func TestCompactionProgressIsASeparateSilentMessage(t *testing.T) {
	editor := &fakeProgressEditor{nextID: 7}
	board := &progressBoard{editor: editor}
	var resumed int
	board.started(t.Context(), agent.ToolActivity{
		RunID: "run-1", Platform: "telegram", ChatID: "100", ThreadID: "3", Name: "bash",
		Input: map[string]any{"command": "pwd"},
	}, func(int64, int) { resumed++ })
	activity := agent.CompactionActivity{
		RunID: "run-1", Platform: "telegram", ChatID: "100", ThreadID: "3",
	}
	board.showCompaction(t.Context(), activity, func(chatID int64, threadID int) {
		if chatID != 100 || threadID != 3 {
			t.Fatalf("resume route = %d/%d", chatID, threadID)
		}
		resumed++
	})
	if resumed != 2 || len(editor.edited) != 0 || len(editor.sent) != 2 ||
		editor.sent[0].Text != "🛠️ Bash: pwd" || editor.sent[1].Text != compactionProgressText ||
		!editor.sent[1].DisableNotification || editor.sent[1].MessageThreadID != 3 {
		t.Fatalf("resumed = %d, sent = %#v, edited = %#v", resumed, editor.sent, editor.edited)
	}
	board.hideCompaction(t.Context(), activity)
	if len(editor.deleted) != 1 || editor.deleted[0].MessageID != 8 || editor.deleted[0].ChatID != int64(100) {
		t.Fatalf("deleted = %#v", editor.deleted)
	}
	board.hideCompaction(t.Context(), activity)
	if len(editor.deleted) != 1 {
		t.Fatalf("second hide deleted = %#v", editor.deleted)
	}
}

func TestProgressBoardStartsFreshMessageAfterNewInput(t *testing.T) {
	editor := &fakeProgressEditor{nextID: 7}
	board := &progressBoard{editor: editor}
	first := agent.ToolActivity{
		RunID: "run-1", Platform: "telegram", ChatID: "100", Name: "bash", InputRevision: 1,
	}
	board.started(t.Context(), first, nil)
	first.Name = "read"
	first.Input = map[string]any{"path": "main.go"}
	board.started(t.Context(), first, nil)
	board.reset(t.Context(), agent.ToolActivity{
		RunID: "run-1", Platform: "telegram", ChatID: "100", InputRevision: 2,
	})
	second := agent.ToolActivity{
		RunID: "run-1", Platform: "telegram", ChatID: "100", Name: "bash", InputRevision: 2,
		Input: map[string]any{"command": "pwd"},
	}
	board.started(t.Context(), second, nil)
	stale := first
	stale.Name = "edit"
	stale.InputRevision = 1
	board.started(t.Context(), stale, nil)
	if len(editor.deleted) != 1 || editor.deleted[0].MessageID != 7 {
		t.Fatalf("deleted = %#v", editor.deleted)
	}
	if len(editor.sent) != 2 || editor.sent[1].Text != "🛠️ Bash: pwd" || !editor.sent[1].DisableNotification {
		t.Fatalf("sent = %#v", editor.sent)
	}
	if len(editor.edited) != 1 || editor.edited[0].Text != "🛠️ Bash\n📖 Read: main.go" {
		t.Fatalf("edited = %#v", editor.edited)
	}
}

func TestProgressBoardEditsOneMessageThenDeletesIt(t *testing.T) {
	editor := &fakeProgressEditor{nextID: 7}
	board := &progressBoard{editor: editor}
	var resumed int
	activity := agent.ToolActivity{
		RunID: "run-1", Platform: "telegram", ChatID: "100", ThreadID: "3", Name: "bash",
	}
	board.started(t.Context(), activity, func(int64, int) { resumed++ })
	activity.Name = "read"
	activity.Input = map[string]any{"path": "main.go"}
	board.started(t.Context(), activity, func(int64, int) { resumed++ })
	if resumed != 1 {
		t.Fatalf("typing resumes = %d, want 1", resumed)
	}
	if len(editor.sent) != 1 || editor.sent[0].Text != "🛠️ Bash" || editor.sent[0].MessageThreadID != 3 || !editor.sent[0].DisableNotification {
		t.Fatalf("sent = %#v", editor.sent)
	}
	if len(editor.edited) != 1 || editor.edited[0].MessageID != 7 || editor.edited[0].Text != "🛠️ Bash\n📖 Read: main.go" {
		t.Fatalf("edited = %#v", editor.edited)
	}
	board.clear(t.Context(), "run-1")
	if len(editor.deleted) != 1 || editor.deleted[0].MessageID != 7 {
		t.Fatalf("deleted = %#v", editor.deleted)
	}
}

func TestProgressBoardKeepsRecentLines(t *testing.T) {
	editor := &fakeProgressEditor{nextID: 1}
	board := &progressBoard{editor: editor}
	for index := range progressMaxLines + 2 {
		board.started(t.Context(), agent.ToolActivity{
			RunID: "run-1", Platform: "telegram", ChatID: "100", Name: "bash",
		}, nil)
		if index == 0 {
			continue
		}
	}
	text := editor.edited[len(editor.edited)-1].Text
	lines := strings.Split(text, "\n")
	if lines[0] != "…" || len(lines) != progressMaxLines+1 {
		t.Fatalf("text = %q", text)
	}
}

func TestDeliverReplyDeletesToolProgress(t *testing.T) {
	payload := []byte(`{"chatId":100,"text":"done"}`)
	editor := &fakeProgressEditor{}
	service := &Service{
		fatalErrors: make(chan error, 1),
		progress: &progressBoard{
			editor: editor,
			drafts: map[string]*progressDraft{
				"run-1": {chatID: 100, messageID: 9, lines: []string{"🛠️ Bash"}},
			},
		},
	}
	source := &fakeReplyQueue{attempt: 1}
	item := conversation.PendingReply{
		ID: "outbox-1", RunID: "run-1", Kind: "final", ChunkIndex: 0, ChunkCount: 1, Payload: payload,
	}
	if err := service.deliverReply(t.Context(), source, &fakeSender{}, item); err != nil {
		t.Fatalf("deliverReply() error = %v", err)
	}
	if len(editor.deleted) != 1 || editor.deleted[0].MessageID != 9 {
		t.Fatalf("deleted = %#v", editor.deleted)
	}
}

func TestDeliverReplyKeepsProgressUntilLastChunk(t *testing.T) {
	editor := &fakeProgressEditor{}
	service := &Service{
		fatalErrors: make(chan error, 1),
		progress: &progressBoard{
			editor: editor,
			drafts: map[string]*progressDraft{
				"run-1": {chatID: 100, messageID: 9},
			},
		},
	}
	source := &fakeReplyQueue{attempt: 1}
	item := conversation.PendingReply{
		ID: "outbox-1", RunID: "run-1", Kind: "final", ChunkIndex: 0, ChunkCount: 2,
		Payload: []byte(`{"chatId":100,"text":"one"}`),
	}
	if err := service.deliverReply(t.Context(), source, &fakeSender{}, item); err != nil {
		t.Fatalf("deliverReply() error = %v", err)
	}
	if len(editor.deleted) != 0 {
		t.Fatalf("deleted = %#v", editor.deleted)
	}
}

type fakeProgressEditor struct {
	nextID  int
	sent    []*bot.SendMessageParams
	edited  []*bot.EditMessageTextParams
	deleted []*bot.DeleteMessageParams
}

func (f *fakeProgressEditor) SendMessage(_ context.Context, params *bot.SendMessageParams) (*models.Message, error) {
	f.sent = append(f.sent, params)
	if f.nextID == 0 {
		f.nextID = 1
	}
	id := f.nextID
	f.nextID++
	return &models.Message{ID: id}, nil
}

func (f *fakeProgressEditor) EditMessageText(_ context.Context, params *bot.EditMessageTextParams) (*models.Message, error) {
	f.edited = append(f.edited, params)
	return &models.Message{ID: params.MessageID}, nil
}

func (f *fakeProgressEditor) DeleteMessage(_ context.Context, params *bot.DeleteMessageParams) (bool, error) {
	f.deleted = append(f.deleted, params)
	return true, nil
}
