package gateway

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/felinics/twilight/sdk"
)

type storedLoopStub struct {
	started     chan struct{}
	resume      chan struct{}
	toolDone    chan struct{}
	resumeFinal chan struct{}
}

func (l *storedLoopStub) RunStored(
	ctx context.Context,
	history []sdk.Message,
	stored agent.StoredConversation,
) (string, error) {
	close(l.started)
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-l.resume:
	}
	tool := &sdk.StepResult{
		Text: "working", FinishReason: sdk.FinishReasonToolCalls,
		Messages: []sdk.Message{sdk.AssistantMessage("working")},
	}
	if _, err := stored.CommitStep(ctx, tool, false); err != nil {
		return "", err
	}
	close(l.toolDone)
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-l.resumeFinal:
	}
	first := &sdk.StepResult{
		Text: "old", FinishReason: sdk.FinishReasonStop,
		Messages: []sdk.Message{sdk.AssistantMessage("old")},
	}
	committed, err := stored.CommitStep(ctx, first, true)
	if err != nil {
		return "", err
	}
	if committed.Sealed || len(committed.NewUserMessages) != 1 {
		return "", &unexpectedStoredStep{step: committed}
	}
	second := &sdk.StepResult{
		Text: "new", FinishReason: sdk.FinishReasonStop,
		Messages: []sdk.Message{sdk.AssistantMessage("new")},
	}
	committed, err = stored.CommitStep(ctx, second, true)
	if err != nil {
		return "", err
	}
	if !committed.Sealed {
		return "", &unexpectedStoredStep{step: committed}
	}
	return "new", nil
}

type unexpectedStoredStep struct {
	step agent.StoredStep
}

func (e *unexpectedStoredStep) Error() string {
	data, _ := json.Marshal(e.step)
	return "unexpected stored step: " + string(data)
}

func TestPersistentGatewayJoinsRunningConversationAndCreatesOutbox(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &storedLoopStub{
		started: make(chan struct{}), resume: make(chan struct{}),
		toolDone: make(chan struct{}), resumeFinal: make(chan struct{}),
	}
	planner := func(reply conversation.FinalReply) ([]conversation.OutboxChunk, error) {
		payload, err := json.Marshal(map[string]string{"text": reply.Text})
		return []conversation.OutboxChunk{{Kind: reply.Kind, Payload: payload}}, err
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test", SystemPrompt: "system",
	}, planner)
	if err != nil {
		t.Fatalf("NewPersistent() error = %v", err)
	}
	t.Cleanup(func() {
		gateway.Close()
		if err := store.Close(); err != nil {
			t.Errorf("store.Close() error = %v", err)
		}
	})

	first, err := gateway.Submit(t.Context(), persistentMessage("event-1", "first"))
	if err != nil {
		t.Fatalf("Submit() first error = %v", err)
	}
	select {
	case <-loop.started:
	case <-time.After(time.Second):
		t.Fatal("stored loop did not start")
	}
	close(loop.resume)
	select {
	case <-loop.toolDone:
	case <-time.After(time.Second):
		t.Fatal("tool step did not commit")
	}
	second, err := gateway.Submit(t.Context(), persistentMessage("event-2", "second"))
	if err != nil {
		t.Fatalf("Submit() second error = %v", err)
	}
	close(loop.resumeFinal)

	for index, receipt := range []*Receipt{first, second} {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		result, waitErr := receipt.Wait(ctx)
		cancel()
		if waitErr != nil {
			t.Fatalf("receipt %d error = %v", index, waitErr)
		}
		if result.Reply != "new" || result.Deliver {
			t.Fatalf("receipt %d result = %#v", index, result)
		}
	}
	pending, err := store.PendingOutbox(t.Context(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("PendingOutbox() error = %v", err)
	}
	if len(pending) != 1 || string(pending[0].Payload) != `{"text":"new"}` {
		t.Fatalf("pending = %#v", pending)
	}
	duplicate, err := gateway.Submit(t.Context(), persistentMessage("event-1", "first"))
	if err != nil {
		t.Fatalf("Submit() completed duplicate error = %v", err)
	}
	result, err := duplicate.Wait(t.Context())
	if err != nil || result != (Result{}) {
		t.Fatalf("completed duplicate result = %#v, %v", result, err)
	}
}

type countingStoredLoop struct {
	calls atomic.Int32
}

func (l *countingStoredLoop) RunStored(
	context.Context,
	[]sdk.Message,
	agent.StoredConversation,
) (string, error) {
	l.calls.Add(1)
	return "unexpected", nil
}

func TestPersistentGatewayRejectsChangedQueuedRunConfiguration(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	message := persistentMessage("event-1", "first")
	userMessage, err := agent.BuildUserMessage(message)
	if err != nil {
		t.Fatalf("BuildUserMessage() error = %v", err)
	}
	encoded, err := conversation.EncodeMessage(userMessage)
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	accepted, err := store.Accept(t.Context(), conversation.AcceptInput{
		Route:           conversation.Route{Platform: "test", AccountID: "account", ChatID: "chat"},
		SourceNamespace: "test:account", SourceEventID: "event-1",
		IngressPayload: message.SourcePayload, Message: encoded,
		Run: conversation.RunSpec{Provider: "test", Model: "old", SystemPrompt: "old"},
	})
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	planned := make(chan conversation.FinalReply, 1)
	planner := func(reply conversation.FinalReply) ([]conversation.OutboxChunk, error) {
		planned <- reply
		return []conversation.OutboxChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{"error":true}`)}}, nil
	}
	loop := &countingStoredLoop{}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "new", SystemPrompt: "new",
	}, planner)
	if err != nil {
		t.Fatalf("NewPersistent() error = %v", err)
	}
	t.Cleanup(func() {
		gateway.Close()
		if err := store.Close(); err != nil {
			t.Errorf("store.Close() error = %v", err)
		}
	})
	select {
	case reply := <-planned:
		if reply.Kind != "error" {
			t.Fatalf("reply kind = %q", reply.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("configuration mismatch was not failed")
	}
	if loop.calls.Load() != 0 {
		t.Fatalf("stored loop calls = %d", loop.calls.Load())
	}
	outcome, err := store.RunOutcome(t.Context(), accepted.RunID)
	if err != nil {
		t.Fatalf("RunOutcome() error = %v", err)
	}
	if outcome.Status != "failed" {
		t.Fatalf("run status = %q, want failed", outcome.Status)
	}
}

func TestPersistentGatewayStopsAcceptingAfterWorkerFailure(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &countingStoredLoop{}
	planner := func(reply conversation.FinalReply) ([]conversation.OutboxChunk, error) {
		return []conversation.OutboxChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test",
	}, planner)
	if err != nil {
		t.Fatalf("NewPersistent() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("store.Close() error = %v", err)
	}
	gateway.signal(gateway.wake)
	deadline := time.Now().Add(time.Second)
	for {
		gateway.mu.Lock()
		closed := gateway.closed
		gateway.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("gateway worker did not stop")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := gateway.Submit(t.Context(), persistentMessage("event-1", "first")); err == nil {
		t.Fatal("Submit() after worker failure error = nil")
	}
	gateway.Close()
}

func persistentMessage(eventID, text string) Message {
	return Message{
		Platform: "test", AccountID: "account", ConversationID: "chat", SenderID: "user",
		SourceNamespace: "test:account", SourceEventID: eventID,
		SourcePayload: json.RawMessage(`{"message":1}`), Text: text,
	}
}
