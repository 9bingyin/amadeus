package gateway

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
)

func TestHandleLogsRawMessageAndReply(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	gateway, err := New(agentLoopFunc(func(context.Context, Message) (string, error) {
		return "raw reply", nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = gateway.Handle(t.Context(), Message{
		Platform: "test", ConversationID: "conversation", SenderID: "sender", Text: "raw prompt",
	})
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	for _, want := range []string{"raw prompt", "raw reply", "conversation", "Handled gateway message"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("logs = %q, want containing %q", logs.String(), want)
		}
	}
}

func TestHandleLogsCancellationAsDebug(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	ctx, cancel := context.WithCancel(t.Context())
	gateway, err := New(agentLoopFunc(func(context.Context, Message) (string, error) {
		cancel()
		return "", context.Canceled
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = gateway.Handle(ctx, Message{
		Platform: "test", ConversationID: "conversation", SenderID: "sender", Text: "prompt",
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Handle() error = %v, want canceled", err)
	}
	if !strings.Contains(logs.String(), "Gateway message canceled") || strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Fatalf("logs = %q", logs.String())
	}
}

func TestNewRequiresAgentLoop(t *testing.T) {
	_, err := New(nil)
	if err == nil || err.Error() != "agent loop is required" {
		t.Fatalf("New() error = %v", err)
	}
}

func TestHandleValidatesMessage(t *testing.T) {
	gateway, err := New(agentLoopFunc(func(context.Context, Message) (string, error) {
		return "", nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	tests := []struct {
		name    string
		message Message
		wantErr string
	}{
		{
			name:    "missing platform",
			message: Message{ConversationID: "chat", SenderID: "user", Text: "hello"},
			wantErr: "platform is required",
		},
		{
			name:    "missing conversation",
			message: Message{Platform: "test", SenderID: "user", Text: "hello"},
			wantErr: "conversation ID is required",
		},
		{
			name:    "missing sender",
			message: Message{Platform: "test", ConversationID: "chat", Text: "hello"},
			wantErr: "sender ID is required",
		},
		{
			name:    "missing text",
			message: Message{Platform: "test", ConversationID: "chat", SenderID: "user"},
			wantErr: "text or attachment is required",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := gateway.Handle(t.Context(), test.message)
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("Handle() error = %v, want containing %q", err, test.wantErr)
			}
		})
	}
}

func TestHandleForwardsNormalizedMessage(t *testing.T) {
	var received Message
	gateway, err := New(agentLoopFunc(func(_ context.Context, message Message) (string, error) {
		received = message
		return "reply", nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	reply, err := gateway.Handle(t.Context(), Message{
		Platform:       " telegram ",
		ConversationID: " 42 ",
		SenderID:       " 7 ",
		Text:           " hello ",
	})
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if reply != "reply" {
		t.Fatalf("reply = %q", reply)
	}
	want := Message{Platform: "telegram", ConversationID: "42", SenderID: "7", Text: "hello"}
	if !reflect.DeepEqual(received, want) {
		t.Fatalf("message = %#v, want %#v", received, want)
	}
}

func TestHandleAcceptsAttachmentOnlyMessage(t *testing.T) {
	var received Message
	gateway, err := New(agentLoopFunc(func(_ context.Context, message Message) (string, error) {
		received = message
		return "reply", nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	attachment := agent.Attachment{
		Kind: agent.AttachmentKindImage, Data: []byte("image"), MediaType: "image/jpeg",
	}
	_, err = gateway.Handle(t.Context(), Message{
		Platform: "telegram", ConversationID: "42", SenderID: "42", Attachments: []agent.Attachment{attachment},
	})
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if !reflect.DeepEqual(received.Attachments, []agent.Attachment{attachment}) {
		t.Fatalf("attachments = %#v", received.Attachments)
	}
}

func TestHandleSerializesAndHonorsCancellation(t *testing.T) {
	firstStarted := make(chan struct{})
	secondStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var calls atomic.Int32
	gateway, err := New(agentLoopFunc(func(ctx context.Context, _ Message) (string, error) {
		if calls.Add(1) == 1 {
			close(firstStarted)
			select {
			case <-releaseFirst:
				return "first", nil
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		close(secondStarted)
		return "second", nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	firstMessage := Message{Platform: "telegram", ConversationID: "one", SenderID: "user", Text: "first"}
	secondMessage := Message{Platform: "discord", ConversationID: "two", SenderID: "user", Text: "second"}
	firstDone := make(chan error, 1)
	go func() {
		_, err := gateway.Handle(t.Context(), firstMessage)
		firstDone <- err
	}()
	<-firstStarted

	secondCtx, cancelSecond := context.WithCancel(t.Context())
	secondCalling := make(chan struct{})
	secondDone := make(chan error, 1)
	go func() {
		close(secondCalling)
		_, err := gateway.Handle(secondCtx, secondMessage)
		secondDone <- err
	}()
	<-secondCalling
	select {
	case <-secondStarted:
		t.Fatal("second message entered agent loop before first completed")
	case <-time.After(50 * time.Millisecond):
	}

	cancelSecond()
	select {
	case err := <-secondDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("second Handle() error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("waiting second message did not honor cancellation")
	}
	if calls.Load() != 1 {
		t.Fatalf("agent calls = %d, want 1", calls.Load())
	}

	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first Handle() error = %v", err)
	}
}

func TestHandleWrapsAgentError(t *testing.T) {
	agentErr := errors.New("failed")
	gateway, err := New(agentLoopFunc(func(context.Context, Message) (string, error) {
		return "", agentErr
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = gateway.Handle(t.Context(), Message{
		Platform: "test", ConversationID: "chat", SenderID: "user", Text: "hello",
	})
	if !errors.Is(err, agentErr) {
		t.Fatalf("Handle() error = %v", err)
	}
}

type agentLoopFunc func(context.Context, Message) (string, error)

func (f agentLoopFunc) Run(ctx context.Context, message Message) (string, error) {
	return f(ctx, message)
}
