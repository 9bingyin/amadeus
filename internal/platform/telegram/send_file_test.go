package telegram

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/felinics/twilight/sdk"
	bot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

func TestSendFileSendsPhotoToCurrentChat(t *testing.T) {
	files, sender := newTestSendFiles(t)
	var resumed [][2]int64
	files.ResumeTyping(func(chatID int64, threadID int) {
		resumed = append(resumed, [2]int64{chatID, int64(threadID)})
	})
	path := filepath.Join(files.workspace, "note.png")
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	result, err := files.Tool().Execute(sendFileContext(), map[string]any{
		"path": "note.png", "kind": "photo", "caption": "see this",
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if result != "sent photo note.png (3 bytes)" {
		t.Fatalf("result = %#v", result)
	}
	if len(sender.photos) != 1 || len(sender.documents) != 0 {
		t.Fatalf("photos = %#v, documents = %#v", sender.photos, sender.documents)
	}
	params := sender.photos[0]
	if params.ChatID != int64(100) || params.MessageThreadID != 7 || params.Caption != "see this" {
		t.Fatalf("params = %#v", params)
	}
	upload, ok := params.Photo.(*models.InputFileUpload)
	if !ok || upload.Filename != "note.png" {
		t.Fatalf("photo = %#v", params.Photo)
	}
	if len(resumed) != 1 || resumed[0] != [2]int64{100, 7} {
		t.Fatalf("resumed typing = %#v", resumed)
	}
}

func TestSendFileSendsOriginalDocument(t *testing.T) {
	files, sender := newTestSendFiles(t)
	path := filepath.Join(files.workspace, "report.pdf")
	if err := os.WriteFile(path, []byte("pdf"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if _, err := files.Tool().Execute(sendFileContext(), map[string]any{
		"path": path, "kind": "document",
	}); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(sender.documents) != 1 || len(sender.photos) != 0 {
		t.Fatalf("documents = %#v, photos = %#v", sender.documents, sender.photos)
	}
	upload, ok := sender.documents[0].Document.(*models.InputFileUpload)
	if !ok || upload.Filename != "report.pdf" {
		t.Fatalf("document = %#v", sender.documents[0].Document)
	}
}

func TestSendFileReturnsTelegramError(t *testing.T) {
	files, sender := newTestSendFiles(t)
	resumed := false
	files.ResumeTyping(func(int64, int) { resumed = true })
	sender.err = errors.New("Bad Request: image dimensions are invalid")
	path := filepath.Join(files.workspace, "note.png")
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	_, err := files.Tool().Execute(sendFileContext(), map[string]any{"path": "note.png", "kind": "photo"})
	if err == nil || err.Error() != sender.err.Error() {
		t.Fatalf("Execute() error = %v", err)
	}
	if resumed {
		t.Fatal("typing resumed after a failed send")
	}
}

func TestSendFileRejectsInvalidInput(t *testing.T) {
	files, _ := newTestSendFiles(t)
	path := filepath.Join(files.workspace, "note.png")
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	large, err := os.Create(filepath.Join(files.workspace, "large.png"))
	if err != nil {
		t.Fatalf("create large file: %v", err)
	}
	if err := large.Truncate(photoMaxBytes + 1); err != nil {
		t.Fatalf("truncate large file: %v", err)
	}
	if err := large.Close(); err != nil {
		t.Fatalf("close large file: %v", err)
	}

	tests := []struct {
		name    string
		ctx     *sdk.ToolExecContext
		input   map[string]any
		wantErr string
	}{
		{name: "missing conversation", ctx: &sdk.ToolExecContext{Context: t.Context()}, input: map[string]any{"path": "note.png", "kind": "photo"}, wantErr: "send_file is only available in a Telegram conversation"},
		{name: "invalid kind", ctx: sendFileContext(), input: map[string]any{"path": "note.png", "kind": "audio"}, wantErr: `kind "audio" is invalid`},
		{name: "long caption", ctx: sendFileContext(), input: map[string]any{"path": "note.png", "kind": "photo", "caption": strings.Repeat("a", 1025)}, wantErr: "caption is longer than 1024 characters"},
		{name: "large photo", ctx: sendFileContext(), input: map[string]any{"path": "large.png", "kind": "photo"}, wantErr: "photo is larger than 10MB"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := files.Tool().Execute(test.ctx, test.input)
			if err == nil || err.Error() != test.wantErr {
				t.Fatalf("Execute() error = %v", err)
			}
		})
	}
}

func TestSendFileRequiresSender(t *testing.T) {
	workspace := t.TempDir()
	files, err := NewSendFiles(workspace)
	if err != nil {
		t.Fatalf("NewSendFiles() error = %v", err)
	}
	path := filepath.Join(workspace, "note.png")
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	_, err = files.Tool().Execute(sendFileContext(), map[string]any{"path": "note.png", "kind": "photo"})
	if err == nil || err.Error() != "telegram file sender is unavailable" {
		t.Fatalf("Execute() error = %v", err)
	}
}

func newTestSendFiles(t *testing.T) (*SendFiles, *fakeFileSender) {
	t.Helper()
	files, err := NewSendFiles(t.TempDir())
	if err != nil {
		t.Fatalf("NewSendFiles() error = %v", err)
	}
	sender := &fakeFileSender{}
	files.Bind(sender)
	return files, sender
}

func sendFileContext() *sdk.ToolExecContext {
	ctx := agent.WithToolRun(context.Background(), agent.ToolRun{
		ID: "run-1", Platform: "telegram", ChatID: "100", ThreadID: "7",
	})
	return &sdk.ToolExecContext{Context: ctx}
}

type fakeFileSender struct {
	photos    []*bot.SendPhotoParams
	documents []*bot.SendDocumentParams
	err       error
}

func (s *fakeFileSender) SendPhoto(_ context.Context, params *bot.SendPhotoParams) (*models.Message, error) {
	s.photos = append(s.photos, params)
	if s.err != nil {
		return nil, s.err
	}
	return &models.Message{}, nil
}

func (s *fakeFileSender) SendDocument(_ context.Context, params *bot.SendDocumentParams) (*models.Message, error) {
	s.documents = append(s.documents, params)
	if s.err != nil {
		return nil, s.err
	}
	return &models.Message{}, nil
}
