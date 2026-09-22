package local

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/gateway"
)

func TestPostUsesStoredIdentity(t *testing.T) {
	var got agent.Message
	platform, err := New(submitterFunc(func(_ context.Context, message agent.Message) (*gateway.Receipt, error) {
		got = message
		return &gateway.Receipt{}, nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	err = platform.Post(t.Context(), Message{
		Route:    Route{Platform: "telegram", AccountID: "bot", ChatID: "chat"},
		Identity: "Schedule #1 点外卖提醒",
		Detail:   "once",
		Text:     "到点了",
		EventID:  "job-1",
	})
	if err != nil {
		t.Fatalf("Post() error = %v", err)
	}
	if got.Platform != "telegram" || got.ConversationID != "chat" || got.SenderID != "Schedule #1 点外卖提醒" ||
		got.SourceNamespace != SourceNamespace || got.SourceEventID != "job-1" {
		t.Fatalf("message = %#v", got)
	}
	if !strings.HasPrefix(got.Text, "[Schedule #1 点外卖提醒 once ") || !strings.HasSuffix(got.Text, "\n到点了") {
		t.Fatalf("text = %q", got.Text)
	}
}

func TestFormat(t *testing.T) {
	at := time.Date(2026, 9, 22, 15, 45, 0, 0, time.UTC)
	got := format("Schedule #1 点外卖提醒", "once", at, "到点了")
	want := "[Schedule #1 点外卖提醒 once Tue 2026-09-22 15:45:00Z]\n到点了"
	if got != want {
		t.Fatalf("format() = %q, want %q", got, want)
	}
}

type submitterFunc func(context.Context, agent.Message) (*gateway.Receipt, error)

func (f submitterFunc) Submit(ctx context.Context, message agent.Message) (*gateway.Receipt, error) {
	return f(ctx, message)
}
