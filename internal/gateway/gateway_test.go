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

	gateway, err := New(t.Context(), agentLoopFunc(func(context.Context, Message) (string, error) {
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
	gateway, err := New(t.Context(), agentLoopFunc(func(context.Context, Message) (string, error) {
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
	_, err := New(t.Context(), nil)
	if err == nil || err.Error() != "agent loop is required" {
		t.Fatalf("New() error = %v", err)
	}
}

func TestHandleValidatesMessage(t *testing.T) {
	gateway, err := New(t.Context(), agentLoopFunc(func(context.Context, Message) (string, error) {
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
	gateway, err := New(t.Context(), agentLoopFunc(func(_ context.Context, message Message) (string, error) {
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
	gateway, err := New(t.Context(), agentLoopFunc(func(_ context.Context, message Message) (string, error) {
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
	gateway, err := New(t.Context(), agentLoopFunc(func(ctx context.Context, _ Message) (string, error) {
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
	select {
	case <-secondStarted:
		t.Fatal("canceled queued message entered agent loop")
	case <-time.After(50 * time.Millisecond):
	}
	if calls.Load() != 1 {
		t.Fatalf("agent calls = %d, want 1", calls.Load())
	}
}

func TestHandleCancellationStopsRunningLegacyAgent(t *testing.T) {
	firstStarted := make(chan struct{})
	firstFinished := make(chan struct{})
	secondStarted := make(chan struct{})
	var calls atomic.Int32
	gateway, err := New(t.Context(), agentLoopFunc(func(ctx context.Context, _ Message) (string, error) {
		if calls.Add(1) == 1 {
			close(firstStarted)
			<-ctx.Done()
			close(firstFinished)
			return "", ctx.Err()
		}
		close(secondStarted)
		return "second", nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	firstCtx, cancelFirst := context.WithCancel(t.Context())
	firstDone := make(chan error, 1)
	go func() {
		_, handleErr := gateway.Handle(firstCtx, Message{
			Platform: "test", ConversationID: "one", SenderID: "user", Text: "first",
		})
		firstDone <- handleErr
	}()
	<-firstStarted
	cancelFirst()
	if handleErr := <-firstDone; !errors.Is(handleErr, context.Canceled) {
		t.Fatalf("first Handle() error = %v", handleErr)
	}
	select {
	case <-firstFinished:
	case <-time.After(time.Second):
		t.Fatal("running legacy agent did not observe request cancellation")
	}

	reply, err := gateway.Handle(t.Context(), Message{
		Platform: "test", ConversationID: "two", SenderID: "user", Text: "second",
	})
	if err != nil {
		t.Fatalf("second Handle() error = %v", err)
	}
	if reply != "second" {
		t.Fatalf("second reply = %q", reply)
	}
	select {
	case <-secondStarted:
	default:
		t.Fatal("second message did not enter agent loop")
	}
}

func TestReceiptCanBeWaitedMoreThanOnce(t *testing.T) {
	gateway, err := New(t.Context(), agentLoopFunc(func(context.Context, Message) (string, error) {
		return "reply", nil
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	receipt, err := gateway.Submit(t.Context(), Message{
		Platform: "test", ConversationID: "one", SenderID: "user", Text: "hello",
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	for attempt := range 2 {
		result, waitErr := receipt.Wait(t.Context())
		if waitErr != nil {
			t.Fatalf("Wait() attempt %d error = %v", attempt, waitErr)
		}
		if result.Reply != "reply" || !result.Deliver {
			t.Fatalf("Wait() attempt %d result = %#v", attempt, result)
		}
	}
}

func TestFailedReceiptCanBeWaitedMoreThanOnce(t *testing.T) {
	agentErr := errors.New("failed")
	gateway, err := New(t.Context(), agentLoopFunc(func(context.Context, Message) (string, error) {
		return "", agentErr
	}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	receipt, err := gateway.Submit(t.Context(), Message{
		Platform: "test", ConversationID: "one", SenderID: "user", Text: "hello",
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	for attempt := range 2 {
		result, waitErr := receipt.Wait(t.Context())
		if !errors.Is(waitErr, agentErr) {
			t.Fatalf("Wait() attempt %d error = %v", attempt, waitErr)
		}
		if !result.Deliver {
			t.Fatalf("Wait() attempt %d result = %#v", attempt, result)
		}
	}
}

func TestSubmitJoinsMessagesIntoActiveRun(t *testing.T) {
	loop := &continuousLoop{
		started: make(chan []Message, 1),
		release: make(chan struct{}),
	}
	gateway, err := New(t.Context(), loop)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	first, err := gateway.Submit(t.Context(), Message{
		Platform: "telegram", ConversationID: "42", SenderID: "42", Text: "first",
	})
	if err != nil {
		t.Fatalf("first Submit() error = %v", err)
	}
	initial := <-loop.started
	if len(initial) != 1 || initial[0].Text != "first" {
		t.Fatalf("initial messages = %#v", initial)
	}
	second, err := gateway.Submit(t.Context(), Message{
		Platform: "telegram", ConversationID: "42", SenderID: "42", Text: "second",
	})
	if err != nil {
		t.Fatalf("second Submit() error = %v", err)
	}
	close(loop.release)

	firstResult, err := first.Wait(t.Context())
	if err != nil {
		t.Fatalf("first receipt error = %v", err)
	}
	secondResult, err := second.Wait(t.Context())
	if err != nil {
		t.Fatalf("second receipt error = %v", err)
	}
	if firstResult.Deliver {
		t.Fatal("first message unexpectedly owns delivery")
	}
	if !secondResult.Deliver || secondResult.Reply != "first,second" {
		t.Fatalf("second result = %#v", secondResult)
	}
	if loop.runs.Load() != 1 {
		t.Fatalf("agent runs = %d, want 1", loop.runs.Load())
	}
}

func TestSubmitAfterSealStartsNewRun(t *testing.T) {
	loop := &sealingLoop{}
	gateway, err := New(t.Context(), loop)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	first, err := gateway.Submit(t.Context(), Message{
		Platform: "telegram", ConversationID: "42", SenderID: "42", Text: "first",
	})
	if err != nil {
		t.Fatalf("first Submit() error = %v", err)
	}
	if _, err := first.Wait(t.Context()); err != nil {
		t.Fatalf("first receipt error = %v", err)
	}
	second, err := gateway.Submit(t.Context(), Message{
		Platform: "telegram", ConversationID: "42", SenderID: "42", Text: "second",
	})
	if err != nil {
		t.Fatalf("second Submit() error = %v", err)
	}
	if _, err := second.Wait(t.Context()); err != nil {
		t.Fatalf("second receipt error = %v", err)
	}
	if loop.runs.Load() != 2 {
		t.Fatalf("agent runs = %d, want 2", loop.runs.Load())
	}
}

func TestHandleWrapsAgentError(t *testing.T) {
	agentErr := errors.New("failed")
	gateway, err := New(t.Context(), agentLoopFunc(func(context.Context, Message) (string, error) {
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

type continuousLoop struct {
	started chan []Message
	release chan struct{}
	runs    atomic.Int32
}

func (l *continuousLoop) Run(context.Context, Message) (string, error) {
	return "", errors.New("unexpected legacy run")
}

func (l *continuousLoop) RunConversation(_ context.Context, initial []Message, inbox agent.Inbox) (string, error) {
	l.runs.Add(1)
	l.started <- initial
	<-l.release
	messages := append([]Message(nil), initial...)
	for {
		pending, sealed := inbox.DrainOrSeal()
		messages = append(messages, pending...)
		if sealed {
			break
		}
	}
	texts := make([]string, len(messages))
	for index, message := range messages {
		texts[index] = message.Text
	}
	return strings.Join(texts, ","), nil
}

type sealingLoop struct {
	runs atomic.Int32
}

func (l *sealingLoop) Run(context.Context, Message) (string, error) {
	return "", errors.New("unexpected legacy run")
}

func (l *sealingLoop) RunConversation(_ context.Context, initial []Message, inbox agent.Inbox) (string, error) {
	l.runs.Add(1)
	if _, sealed := inbox.DrainOrSeal(); !sealed {
		return "", errors.New("unexpected pending message")
	}
	return initial[0].Text, nil
}

type agentLoopFunc func(context.Context, Message) (string, error)

func (f agentLoopFunc) Run(ctx context.Context, message Message) (string, error) {
	return f(ctx, message)
}
