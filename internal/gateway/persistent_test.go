package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/9bingyin/amadeus/internal/memory"
	"github.com/felinics/twilight/sdk"
)

type windowStoredLoop struct {
	history chan []sdk.Message
}

func (l *windowStoredLoop) RunStored(
	ctx context.Context,
	history []sdk.Message,
	stored agent.StoredConversation,
) (string, error) {
	l.history <- append([]sdk.Message(nil), history...)
	step := &sdk.StepResult{
		Text: "done", FinishReason: sdk.FinishReasonStop,
		Messages: []sdk.Message{sdk.AssistantMessage("done")},
	}
	committed, err := stored.CommitStep(ctx, step, true)
	if err != nil {
		return "", err
	}
	if !committed.Sealed {
		return "", &unexpectedStoredStep{step: committed}
	}
	return "done", nil
}

func TestPersistentGatewayCollectsInitialWindow(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &windowStoredLoop{history: make(chan []sdk.Message, 1)}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test", InputWindow: 80 * time.Millisecond,
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
	case history := <-loop.history:
		t.Fatalf("loop started before window closed with history %#v", history)
	case <-time.After(20 * time.Millisecond):
	}
	second, err := gateway.Submit(t.Context(), persistentMessage("event-2", "second"))
	if err != nil {
		t.Fatalf("Submit() second error = %v", err)
	}
	select {
	case history := <-loop.history:
		if got := userTexts(history); len(got) != 2 || got[0] != "first" || got[1] != "second" {
			t.Fatalf("history user texts = %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("stored loop did not start after input window")
	}
	for index, receipt := range []*Receipt{first, second} {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		result, waitErr := receipt.Wait(ctx)
		cancel()
		if waitErr != nil || result.Reply != "done" {
			t.Fatalf("receipt %d = %#v, %v", index, result, waitErr)
		}
	}
}

type stopTestLoop struct {
	started chan struct{}
	seen    chan []sdk.Message
	calls   atomic.Int32
}

func (l *stopTestLoop) RunStored(ctx context.Context, history []sdk.Message, stored agent.StoredConversation) (string, error) {
	if l.calls.Add(1) == 1 {
		close(l.started)
		<-ctx.Done()
		return "", ctx.Err()
	}
	l.seen <- history
	step := &sdk.StepResult{
		Text: "done", FinishReason: sdk.FinishReasonStop,
		Messages: []sdk.Message{sdk.AssistantMessage("done")},
	}
	_, err := stored.CommitStep(ctx, step, true)
	return "done", err
}

func TestPersistentGatewayStopRunningConversation(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	loop := &stopTestLoop{started: make(chan struct{}), seen: make(chan []sdk.Message, 1)}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test",
	}, planner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		gateway.Close()
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	first, err := gateway.Submit(t.Context(), persistentMessage("event-1", "first"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-loop.started:
	case <-time.After(time.Second):
		t.Fatal("run did not start")
	}
	otherMessage := persistentMessage("other-event", "other chat")
	otherMessage.ConversationID = "other-chat"
	other, err := gateway.Submit(t.Context(), otherMessage)
	if err != nil {
		t.Fatal(err)
	}
	wrongRoute := ConversationReference{
		Platform: "test", AccountID: "account", ConversationID: "other-chat",
		SourceNamespace: "test:account", SourceEventID: "stop-other",
		SuccessReply: "stopped", EmptyReply: "idle",
	}
	if err := gateway.StopConversation(t.Context(), wrongRoute); err != nil {
		t.Fatalf("StopConversation(other chat): %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if result, err := other.Wait(ctx); err != nil || result.Deliver {
		t.Fatalf("other chat queued receipt = %#v, %v", result, err)
	}
	select {
	case <-first.state.done:
		t.Fatal("other chat stop interrupted run")
	default:
	}
	reference := wrongRoute
	reference.ConversationID = "chat"
	reference.SourceEventID = "stop-1"
	if err := gateway.StopConversation(t.Context(), reference); err != nil {
		t.Fatalf("StopConversation() error = %v", err)
	}
	if result, err := first.Wait(ctx); err != nil || result.Deliver {
		t.Fatalf("stopped receipt = %#v, %v", result, err)
	}
	_, snapshot, err := store.ContextByRoute(t.Context(), conversation.Route{
		Platform: "test", AccountID: "account", ChatID: "chat",
	})
	if err != nil || len(snapshot.Messages) != 2 || snapshot.Messages[1].Role != sdk.MessageRoleAssistant ||
		snapshot.Messages[1].Content[0].(sdk.TextPart).Text != "[Aborted: user stop]" {
		t.Fatalf("stopped history = %#v, %v", snapshot, err)
	}
	second, err := gateway.Submit(t.Context(), persistentMessage("event-2", "second"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := second.Wait(ctx)
	if err != nil || result.Reply != "done" {
		t.Fatalf("later run = %#v, %v", result, err)
	}
	history := <-loop.seen
	if len(history) != 3 || history[1].Role != sdk.MessageRoleAssistant ||
		history[1].Content[0].(sdk.TextPart).Text != "[Aborted: user stop]" {
		t.Fatalf("later run did not see stop: %#v", history)
	}
	if err := gateway.StopConversation(t.Context(), reference); err != nil {
		t.Fatalf("duplicate StopConversation(): %v", err)
	}
}

func TestPersistentGatewayStopQueuedConversation(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	loop := &windowStoredLoop{history: make(chan []sdk.Message, 2)}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test", InputWindow: 100 * time.Millisecond,
	}, planner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		gateway.Close()
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	first, err := gateway.Submit(t.Context(), persistentMessage("event-1", "first"))
	if err != nil {
		t.Fatal(err)
	}
	if err := gateway.StopConversation(t.Context(), ConversationReference{
		Platform: "test", AccountID: "account", ConversationID: "chat",
		SourceNamespace: "test:account", SourceEventID: "stop-1",
		SuccessReply: "stopped", EmptyReply: "idle",
	}); err != nil {
		t.Fatalf("StopConversation(queued): %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if result, err := first.Wait(ctx); err != nil || result.Deliver {
		t.Fatalf("queued receipt = %#v, %v", result, err)
	}
	second, err := gateway.Submit(t.Context(), persistentMessage("event-2", "second"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case history := <-loop.history:
		if got := userTexts(history); len(got) != 2 || got[0] != "first" || got[1] != "second" {
			t.Fatalf("history = %#v", got)
		}
	case <-ctx.Done():
		t.Fatal("new run did not start")
	}
	if result, err := second.Wait(ctx); err != nil || result.Reply != "done" {
		t.Fatalf("new run = %#v, %v", result, err)
	}
}

type commandStoredLoop struct{}

func (*commandStoredLoop) RunStored(
	ctx context.Context,
	_ []sdk.Message,
	stored agent.StoredConversation,
) (string, error) {
	step := &sdk.StepResult{
		Text: "done", FinishReason: sdk.FinishReasonStop,
		Messages: []sdk.Message{sdk.AssistantMessage("done")},
	}
	_, err := stored.CommitStep(ctx, step, true)
	return "done", err
}

func (*commandStoredLoop) EstimateContextTokens([]sdk.Message) int {
	return 28_741
}

func (*commandStoredLoop) CompactContext(
	_ context.Context,
	history []sdk.Message,
) (agent.ContextCompaction, error) {
	if len(history) < 2 {
		return agent.ContextCompaction{}, agent.ErrContextNotCompactable
	}
	return agent.ContextCompaction{
		Replacement:  []sdk.Message{sdk.UserMessage("manual summary")},
		SummaryModel: "test", SummaryPromptVersion: 1,
		EstimatedTokensBefore: 100, EstimatedTokensAfter: 20,
	}, nil
}

func TestPersistentGatewayReportsDurableStatus(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		payload, marshalErr := json.Marshal(struct {
			Text string `json:"text"`
		}{Text: reply.Text})
		if marshalErr != nil {
			return nil, marshalErr
		}
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: payload}}, nil
	}
	gateway, err := NewPersistent(t.Context(), &commandStoredLoop{}, store, conversation.RunSpec{
		Provider: "openai-responses", Model: "gpt-5.6-luna", ReasoningEffort: "high",
		ContextWindowTokens: 128_000,
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
	formatted := 0
	var gotStatus ConversationStatus
	reference := ConversationReference{
		Platform: "test", AccountID: "account", ConversationID: "chat",
		SourceNamespace: "test:account", SourceEventID: "status-1",
		SourcePayload: json.RawMessage(`{"message":1}`),
		FormatStatus: func(status ConversationStatus) string {
			formatted++
			gotStatus = status
			return "status reply"
		},
	}
	if err := gateway.StatusConversation(t.Context(), reference); err != nil {
		t.Fatalf("StatusConversation() error = %v", err)
	}
	if gotStatus.SessionID == "" || gotStatus.Provider != "openai-responses" ||
		gotStatus.Model != "gpt-5.6-luna" || gotStatus.ReasoningEffort != "high" ||
		gotStatus.EstimatedContextTokens != 28_741 || gotStatus.ContextWindowTokens != 128_000 ||
		gotStatus.InputTokens != 0 || gotStatus.CachedInputTokens != 0 {
		t.Fatalf("status = %#v", gotStatus)
	}
	result, completed, err := store.ContextCommandResult(t.Context(), conversation.ContextCommand{
		Route:           conversation.Route{Platform: "test", AccountID: "account", ChatID: "chat"},
		SourceNamespace: "test:account", SourceEventID: "status-1",
	})
	if err != nil || !completed || result != conversation.CommandResultShown {
		t.Fatalf("ContextCommandResult() = %q, %v, %v", result, completed, err)
	}
	if err := gateway.StatusConversation(t.Context(), reference); err != nil {
		t.Fatalf("StatusConversation() replay error = %v", err)
	}
	if formatted != 1 {
		t.Fatalf("status formatter calls = %d, want 1", formatted)
	}
	pending, err := store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(pending) != 1 {
		t.Fatalf("PendingReply() = %#v, %v", pending, err)
	}
}

type failingCompactionLoop struct {
	commandStoredLoop
}

func (*failingCompactionLoop) CompactContext(
	context.Context,
	[]sdk.Message,
) (agent.ContextCompaction, error) {
	return agent.ContextCompaction{}, errors.New("provider unavailable")
}

func TestPersistentGatewayPersistsManualCompactionFailure(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), &failingCompactionLoop{}, store, conversation.RunSpec{
		Provider: "test", Model: "test",
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
	receipt, err := gateway.Submit(t.Context(), persistentMessage("event-1", "hello"))
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if _, err := receipt.Wait(t.Context()); err != nil {
		t.Fatalf("receipt.Wait() error = %v", err)
	}
	reference := ConversationReference{
		Platform: "test", AccountID: "account", ConversationID: "chat",
		SourceNamespace: "test:account", SourceEventID: "compact-failed",
		SourcePayload: json.RawMessage(`{"message":2}`),
		SuccessReply:  "compacted", EmptyReply: "nothing",
	}
	if err := gateway.CompactConversation(t.Context(), reference); err != nil {
		t.Fatalf("CompactConversation() error = %v", err)
	}
	result, completed, err := store.ContextCommandResult(t.Context(), conversation.ContextCommand{
		Route:           conversation.Route{Platform: "test", AccountID: "account", ChatID: "chat"},
		SourceNamespace: "test:account", SourceEventID: "compact-failed",
	})
	if err != nil || !completed || result != conversation.CommandResultFailed {
		t.Fatalf("ContextCommandResult() = %q, %v, %v", result, completed, err)
	}
	if err := gateway.CompactConversation(t.Context(), reference); err != nil {
		t.Fatalf("CompactConversation() replay error = %v", err)
	}
}

type maintenanceOrderingLoop struct {
	calls         atomic.Int32
	firstStarted  chan struct{}
	releaseFirst  chan struct{}
	secondHistory chan []sdk.Message
}

func (*maintenanceOrderingLoop) EstimateContextTokens([]sdk.Message) int {
	return 42
}

func (l *maintenanceOrderingLoop) RunStored(
	ctx context.Context,
	history []sdk.Message,
	stored agent.StoredConversation,
) (string, error) {
	if l.calls.Add(1) == 1 {
		close(l.firstStarted)
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-l.releaseFirst:
		}
	} else {
		l.secondHistory <- append([]sdk.Message(nil), history...)
	}
	step := &sdk.StepResult{
		Text: "done", FinishReason: sdk.FinishReasonStop,
		Messages: []sdk.Message{sdk.AssistantMessage("done")},
	}
	_, err := stored.CommitStep(ctx, step, true)
	return "done", err
}

func TestPersistentGatewayStatusDoesNotWaitForRunningAgent(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &maintenanceOrderingLoop{
		firstStarted: make(chan struct{}), releaseFirst: make(chan struct{}),
		secondHistory: make(chan []sdk.Message, 1),
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "openai-responses", Model: "test", ContextWindowTokens: 128_000,
	}, planner)
	if err != nil {
		t.Fatalf("NewPersistent() error = %v", err)
	}
	defer func() {
		close(loop.releaseFirst)
		gateway.Close()
		if err := store.Close(); err != nil {
			t.Errorf("store.Close() error = %v", err)
		}
	}()
	if _, err := gateway.Submit(t.Context(), persistentMessage("event-1", "first")); err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	select {
	case <-loop.firstStarted:
	case <-time.After(time.Second):
		t.Fatal("agent run did not start")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	var status ConversationStatus
	if err := gateway.StatusConversation(ctx, ConversationReference{
		Platform: "test", AccountID: "account", ConversationID: "chat",
		SourceNamespace: "test:account", SourceEventID: "status-running",
		FormatStatus: func(value ConversationStatus) string {
			status = value
			return "status"
		},
	}); err != nil {
		t.Fatalf("StatusConversation() while running error = %v", err)
	}
	if status.SessionID == "" || status.EstimatedContextTokens != 42 {
		t.Fatalf("status while running = %#v", status)
	}
}

func TestPersistentGatewayCommandWaitsForQueuedInputWindow(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &windowStoredLoop{history: make(chan []sdk.Message, 1)}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test", InputWindow: 80 * time.Millisecond,
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
	receipt, err := gateway.Submit(t.Context(), persistentMessage("event-1", "before command"))
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	commandDone := make(chan error, 1)
	go func() {
		commandDone <- gateway.NewConversation(t.Context(), ConversationReference{
			Platform: "test", AccountID: "account", ConversationID: "chat",
			SourceNamespace: "test:account", SourceEventID: "new-after-windowed-input",
			SourcePayload: json.RawMessage(`{"message":2}`), SuccessReply: "new",
		})
	}()
	select {
	case err := <-commandDone:
		t.Fatalf("new command crossed queued input window: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	select {
	case history := <-loop.history:
		if got := userTexts(history); len(got) != 1 || got[0] != "before command" {
			t.Fatalf("windowed run history = %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("windowed run did not start")
	}
	if result, waitErr := receipt.Wait(t.Context()); waitErr != nil || result.Reply != "done" {
		t.Fatalf("windowed receipt = %#v, %v", result, waitErr)
	}
	select {
	case err := <-commandDone:
		if err != nil {
			t.Fatalf("NewConversation() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("new command did not finish after queued run")
	}
	_, snapshot, err := store.ContextByRoute(t.Context(), conversation.Route{
		Platform: "test", AccountID: "account", ChatID: "chat",
	})
	if err != nil || len(snapshot.Messages) != 0 {
		t.Fatalf("context after /new = %#v, %v", snapshot, err)
	}
}

func TestPersistentGatewayCommandCreatesAdmissionBoundary(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &maintenanceOrderingLoop{
		firstStarted: make(chan struct{}), releaseFirst: make(chan struct{}),
		secondHistory: make(chan []sdk.Message, 1),
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test",
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
	case <-loop.firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first run did not start")
	}
	commandDone := make(chan error, 1)
	go func() {
		commandDone <- gateway.NewConversation(t.Context(), ConversationReference{
			Platform: "test", AccountID: "account", ConversationID: "chat",
			SourceNamespace: "test:account", SourceEventID: "new-between-runs",
			SourcePayload: json.RawMessage(`{"message":2}`), SuccessReply: "new",
		})
	}()
	deadline := time.Now().Add(time.Second)
	for len(gateway.maintenance) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("new command was not queued")
		}
		time.Sleep(time.Millisecond)
	}
	secondSubmitted := make(chan *Receipt, 1)
	secondSubmitError := make(chan error, 1)
	go func() {
		receipt, submitErr := gateway.Submit(t.Context(), persistentMessage("event-3", "second"))
		if submitErr != nil {
			secondSubmitError <- submitErr
			return
		}
		secondSubmitted <- receipt
	}()
	close(loop.releaseFirst)
	if result, waitErr := first.Wait(t.Context()); waitErr != nil || result.Reply != "done" {
		t.Fatalf("first receipt = %#v, %v", result, waitErr)
	}
	select {
	case err := <-commandDone:
		if err != nil {
			t.Fatalf("NewConversation() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("new command did not finish")
	}
	var second *Receipt
	select {
	case err := <-secondSubmitError:
		t.Fatalf("Submit() second error = %v", err)
	case second = <-secondSubmitted:
	case <-time.After(time.Second):
		t.Fatal("second submission remained blocked")
	}
	select {
	case history := <-loop.secondHistory:
		if got := userTexts(history); len(got) != 1 || got[0] != "second" {
			t.Fatalf("second run history = %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("second run did not start")
	}
	if result, waitErr := second.Wait(t.Context()); waitErr != nil || result.Reply != "done" {
		t.Fatalf("second receipt = %#v, %v", result, waitErr)
	}
}

type blockingCompactionLoop struct {
	commandStoredLoop
	started chan struct{}
}

func (l *blockingCompactionLoop) CompactContext(
	ctx context.Context,
	_ []sdk.Message,
) (agent.ContextCompaction, error) {
	close(l.started)
	<-ctx.Done()
	return agent.ContextCompaction{}, ctx.Err()
}

func TestPersistentGatewayCloseCancelsManualCompaction(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &blockingCompactionLoop{started: make(chan struct{})}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test",
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
	receipt, err := gateway.Submit(t.Context(), persistentMessage("event-1", "hello"))
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if _, err := receipt.Wait(t.Context()); err != nil {
		t.Fatalf("receipt.Wait() error = %v", err)
	}
	commandDone := make(chan error, 1)
	go func() {
		commandDone <- gateway.CompactConversation(context.Background(), ConversationReference{
			Platform: "test", AccountID: "account", ConversationID: "chat",
			SourceNamespace: "test:account", SourceEventID: "compact-blocking",
			SourcePayload: json.RawMessage(`{"message":2}`),
			SuccessReply:  "compacted", EmptyReply: "nothing",
		})
	}()
	select {
	case <-loop.started:
	case <-time.After(time.Second):
		t.Fatal("manual compaction did not start")
	}
	closed := make(chan struct{})
	go func() {
		gateway.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("gateway close waited for manual compaction")
	}
	select {
	case err := <-commandDone:
		if err == nil {
			t.Fatal("manual compaction error = nil after gateway close")
		}
	case <-time.After(time.Second):
		t.Fatal("manual compaction caller did not finish")
	}
}

func TestPersistentGatewayConversationCommands(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), &commandStoredLoop{}, store, conversation.RunSpec{
		Provider: "test", Model: "test",
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
	initialNew := ConversationReference{
		Platform: "test", AccountID: "account", ConversationID: "chat",
		SourceNamespace: "test:account", SourceEventID: "new-before-history",
		SourcePayload: json.RawMessage(`{"message":0}`),
		SuccessReply:  "new conversation", EmptyReply: "nothing",
	}
	if err := gateway.NewConversation(t.Context(), initialNew); err != nil {
		t.Fatalf("NewConversation() without history error = %v", err)
	}
	pending, err := store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(pending) != 1 || pending[0].Kind != "command" {
		t.Fatalf("initial command outbox = %#v, %v", pending, err)
	}
	if _, err := store.StartDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("StartDelivery() initial command error = %v", err)
	}
	if err := store.CompleteDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("CompleteDelivery() initial command error = %v", err)
	}
	receipt, err := gateway.Submit(t.Context(), persistentMessage("event-1", "hello"))
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if _, err := receipt.Wait(t.Context()); err != nil {
		t.Fatalf("receipt.Wait() error = %v", err)
	}
	if err := gateway.NewConversation(t.Context(), initialNew); err != nil {
		t.Fatalf("NewConversation() replay error = %v", err)
	}
	_, replayedContext, err := store.ContextByRoute(t.Context(), conversation.Route{
		Platform: "test", AccountID: "account", ChatID: "chat",
	})
	if err != nil || len(replayedContext.Messages) != 2 {
		t.Fatalf("context after replayed /new = %#v, %v", replayedContext, err)
	}
	reference := ConversationReference{
		Platform: "test", AccountID: "account", ConversationID: "chat",
		SourceNamespace: "test:account", SourceEventID: "compact-1",
		SourcePayload: json.RawMessage(`{"message":2}`),
		SuccessReply:  "compacted", EmptyReply: "nothing to compact",
	}
	if err := gateway.CompactConversation(t.Context(), reference); err != nil {
		t.Fatalf("CompactConversation() error = %v", err)
	}
	pending, err = store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(pending) != 1 || pending[0].Kind != "final" {
		t.Fatalf("pending before final delivery = %#v, %v", pending, err)
	}
	if _, err := store.StartDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("StartDelivery() final error = %v", err)
	}
	if err := store.CompleteDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("CompleteDelivery() final error = %v", err)
	}
	pending, err = store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(pending) != 1 || pending[0].Kind != "command" {
		t.Fatalf("pending command delivery = %#v, %v", pending, err)
	}
	if _, err := store.StartDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("StartDelivery() command error = %v", err)
	}
	if err := store.CompleteDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("CompleteDelivery() command error = %v", err)
	}
	_, snapshot, err := store.ContextByRoute(t.Context(), conversation.Route{
		Platform: "test", AccountID: "account", ChatID: "chat",
	})
	if err != nil || len(snapshot.Messages) != 1 || messageText(snapshot.Messages[0]) != "manual summary" {
		t.Fatalf("compacted context = %#v, %v", snapshot, err)
	}
	reference.SourceEventID = "new-1"
	if err := gateway.NewConversation(t.Context(), reference); err != nil {
		t.Fatalf("NewConversation() error = %v", err)
	}
	_, snapshot, err = store.ContextByRoute(t.Context(), conversation.Route{
		Platform: "test", AccountID: "account", ChatID: "chat",
	})
	if err != nil || len(snapshot.Messages) != 0 {
		t.Fatalf("new conversation context = %#v, %v", snapshot, err)
	}
	if err := gateway.NewConversation(t.Context(), reference); err != nil {
		t.Fatalf("NewConversation() duplicate error = %v", err)
	}
	pending, err = store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(pending) != 1 || pending[0].Kind != "command" {
		t.Fatalf("pending new command delivery = %#v, %v", pending, err)
	}
}

func messageText(message sdk.Message) string {
	if len(message.Content) != 1 {
		return ""
	}
	text, _ := message.Content[0].(sdk.TextPart)
	return text.Text
}

func userTexts(messages []sdk.Message) []string {
	texts := make([]string, 0, len(messages))
	for _, message := range messages {
		if message.Role != sdk.MessageRoleUser {
			continue
		}
		for _, part := range message.Content {
			if text, ok := part.(sdk.TextPart); ok {
				texts = append(texts, text.Text)
			}
		}
	}
	return texts
}

func TestRunControlIgnoresDelayedAcknowledgedSignal(t *testing.T) {
	control := newRunControl()
	control.acknowledge(2)
	watch := control.watch(2)
	control.signal(2)
	select {
	case <-watch:
		t.Fatal("acknowledged revision canceled the current request")
	default:
	}
	control.signal(3)
	select {
	case <-watch:
	case <-time.After(time.Second):
		t.Fatal("newer revision did not cancel the current request")
	}
}

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
	if committed.Sealed {
		return "", &unexpectedStoredStep{step: committed}
	}
	input, err := stored.PrepareRequest(ctx)
	if err != nil {
		return "", err
	}
	if len(input.Messages) != 1 {
		return "", &unexpectedStoredInput{input: input}
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

type unexpectedStoredInput struct {
	input agent.StoredInput
}

func (e *unexpectedStoredInput) Error() string {
	data, _ := json.Marshal(e.input)
	return "unexpected stored input: " + string(data)
}

func TestPersistentGatewayJoinsRunningConversationAndCreatesReplies(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	loop := &storedLoopStub{
		started: make(chan struct{}), resume: make(chan struct{}),
		toolDone: make(chan struct{}), resumeFinal: make(chan struct{}),
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		payload, err := json.Marshal(map[string]string{"text": reply.Text})
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: payload}}, err
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
	pending, err := store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("PendingReply() error = %v", err)
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
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		planned <- reply
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{"error":true}`)}}, nil
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
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
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

func TestPersistentGatewayCompactsIdleConversation(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), &commandStoredLoop{}, store, conversation.RunSpec{
		Provider: "test", Model: "test",
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
	receipt, err := gateway.Submit(t.Context(), persistentMessage("event-1", "hello"))
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if _, err := receipt.Wait(t.Context()); err != nil {
		t.Fatalf("receipt.Wait() error = %v", err)
	}
	before, err := store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("PendingReply() error = %v", err)
	}
	gateway.EnableIdleCompaction(time.Millisecond, "local")
	activity := waitIdleActivity(t, store)
	deadline := time.Now().Add(2 * time.Second)
	var result string
	var completed bool
	eventID := activity[0].ID + ":" + formatUnixMilli(activity[0].LastUserAt)
	for time.Now().Before(deadline) {
		result, completed, err = store.ContextCommandResult(t.Context(), conversation.ContextCommand{
			Route:           activity[0].Route,
			SourceNamespace: idleCommandNamespace,
			SourceEventID:   eventID,
		})
		if err != nil {
			t.Fatalf("ContextCommandResult() error = %v", err)
		}
		if completed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !completed || result != conversation.CommandResultCompacted {
		t.Fatalf("idle compaction = %q, completed %v", result, completed)
	}
	_, snapshot, err := store.ContextByRoute(t.Context(), activity[0].Route)
	if err != nil {
		t.Fatalf("ContextByRoute() error = %v", err)
	}
	if len(snapshot.Messages) != 1 || snapshot.CheckpointRecordID == "" {
		t.Fatalf("snapshot messages = %d, checkpoint %q", len(snapshot.Messages), snapshot.CheckpointRecordID)
	}
	after, err := store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(after) != len(before) {
		t.Fatalf("PendingReply() = %d, want %d, err %v", len(after), len(before), err)
	}
}

func TestPersistentGatewaySkipsUncompactableIdleConversation(t *testing.T) {
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), &notCompactableLoop{}, store, conversation.RunSpec{
		Provider: "test", Model: "test",
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
	receipt, err := gateway.Submit(t.Context(), persistentMessage("event-1", "hello"))
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if _, err := receipt.Wait(t.Context()); err != nil {
		t.Fatalf("receipt.Wait() error = %v", err)
	}
	before, err := store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("PendingReply() error = %v", err)
	}
	gateway.EnableIdleCompaction(time.Millisecond, "local")
	activity := waitIdleActivity(t, store)
	eventID := activity[0].ID + ":" + formatUnixMilli(activity[0].LastUserAt)
	deadline := time.Now().Add(2 * time.Second)
	var result string
	var completed bool
	for time.Now().Before(deadline) {
		result, completed, err = store.ContextCommandResult(t.Context(), conversation.ContextCommand{
			Route:           activity[0].Route,
			SourceNamespace: idleCommandNamespace,
			SourceEventID:   eventID,
		})
		if err != nil {
			t.Fatalf("ContextCommandResult() error = %v", err)
		}
		if completed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !completed || result != conversation.CommandResultNotCompactable {
		t.Fatalf("idle compaction = %q, completed %v", result, completed)
	}
	after, err := store.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(after) != len(before) {
		t.Fatalf("PendingReply() = %d, want %d, err %v", len(after), len(before), err)
	}
}

type notCompactableLoop struct {
	commandStoredLoop
}

func (*notCompactableLoop) CompactContext(context.Context, []sdk.Message) (agent.ContextCompaction, error) {
	return agent.ContextCompaction{}, agent.ErrContextNotCompactable
}

func waitIdleActivity(t *testing.T, store *conversation.Store) []conversation.ConversationActivity {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		activity, err := store.ListConversationUserActivity(t.Context(), "local")
		if err != nil {
			t.Fatalf("ListConversationUserActivity() error = %v", err)
		}
		if len(activity) == 1 {
			return activity
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("idle conversation was not listed")
	return nil
}

func formatUnixMilli(at time.Time) string {
	return strconv.FormatInt(at.UnixMilli(), 10)
}

func TestPersistentGatewayShortensFullMemory(t *testing.T) {
	memories := fullUserMemory(t)
	loop := &shorteningDreamLoop{extra: make(chan struct{}, 1)}
	gateway := newDreamGateway(t, loop)
	gateway.EnableDream(memories)
	waitForMemory(t, memories, "- brief")
	if loop.calls.Load() != 1 {
		t.Fatalf("RewriteMemory calls = %d, want 1", loop.calls.Load())
	}
	gateway.signal(gateway.dreamWake)
	select {
	case <-loop.extra:
		t.Fatal("RewriteMemory ran again for the same memory")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestPersistentGatewayWaitsToDreamUntilTheRunFinishes(t *testing.T) {
	memories := fullUserMemory(t)
	loop := &blockingDreamLoop{
		started: make(chan struct{}), release: make(chan struct{}), rewritten: make(chan struct{}, 1),
	}
	gateway := newDreamGateway(t, loop)
	receipt, err := gateway.Submit(t.Context(), persistentMessage("event-1", "hello"))
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	select {
	case <-loop.started:
	case <-time.After(time.Second):
		t.Fatal("run did not start")
	}
	gateway.EnableDream(memories)
	select {
	case <-loop.rewritten:
		t.Fatal("dreamed during the run")
	case <-time.After(200 * time.Millisecond):
	}
	close(loop.release)
	if _, err := receipt.Wait(t.Context()); err != nil {
		t.Fatalf("receipt.Wait() error = %v", err)
	}
	waitForMemory(t, memories, "- brief")
}

func TestPersistentGatewaySkipsAFailedMemoryRewrite(t *testing.T) {
	memories := fullUserMemory(t)
	loop := &failingDreamLoop{extra: make(chan struct{}, 1)}
	gateway := newDreamGateway(t, loop)
	gateway.EnableDream(memories)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if loop.calls.Load() > 0 {
			_, ok, err := memories.NextDream()
			if err != nil {
				t.Fatalf("NextDream() error = %v", err)
			}
			if !ok {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("failed rewrite was not recorded")
		}
		time.Sleep(10 * time.Millisecond)
	}
	user, _, err := memories.Load()
	if err != nil || !strings.HasPrefix(user, "- "+strings.Repeat("a", 20)) {
		t.Fatalf("Load() = %q, %v", user, err)
	}
	gateway.signal(gateway.dreamWake)
	select {
	case <-loop.extra:
		t.Fatal("RewriteMemory retried the same memory")
	case <-time.After(200 * time.Millisecond):
	}
}

type shorteningDreamLoop struct {
	commandStoredLoop
	calls atomic.Int32
	extra chan struct{}
}

func (l *shorteningDreamLoop) RewriteMemory(context.Context, string, string, int) (string, error) {
	if l.calls.Add(1) > 1 {
		l.extra <- struct{}{}
	}
	return "- brief", nil
}

type failingDreamLoop struct {
	commandStoredLoop
	calls atomic.Int32
	extra chan struct{}
}

func (l *failingDreamLoop) RewriteMemory(context.Context, string, string, int) (string, error) {
	if l.calls.Add(1) > 1 {
		l.extra <- struct{}{}
	}
	return "", errors.New("rewrite failed")
}

type blockingDreamLoop struct {
	commandStoredLoop
	started   chan struct{}
	release   chan struct{}
	rewritten chan struct{}
}

func (l *blockingDreamLoop) RunStored(
	ctx context.Context,
	history []sdk.Message,
	stored agent.StoredConversation,
) (string, error) {
	close(l.started)
	select {
	case <-l.release:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	return l.commandStoredLoop.RunStored(ctx, history, stored)
}

func (l *blockingDreamLoop) RewriteMemory(context.Context, string, string, int) (string, error) {
	select {
	case l.rewritten <- struct{}{}:
	default:
	}
	return "- brief", nil
}

func newDreamGateway(t *testing.T, loop storedAgentLoop) *PersistentGateway {
	t.Helper()
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("conversation.Open() error = %v", err)
	}
	planner := func(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
		return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: json.RawMessage(`{}`)}}, nil
	}
	gateway, err := NewPersistent(t.Context(), loop, store, conversation.RunSpec{
		Provider: "test", Model: "test",
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
	return gateway
}

func fullUserMemory(t *testing.T) *memory.Store {
	t.Helper()
	store, err := memory.Open(t.TempDir())
	if err != nil {
		t.Fatalf("memory.Open() error = %v", err)
	}
	if _, err := store.Apply("user", "add", strings.Repeat("a", 1200), ""); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	return store
}

func waitForMemory(t *testing.T, store *memory.Store, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		user, _, err := store.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if user == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("memory = not %q", want)
}

func persistentMessage(eventID, text string) Message {
	return Message{
		Platform: "test", AccountID: "account", ConversationID: "chat", SenderID: "user",
		SourceNamespace: "test:account", SourceEventID: eventID,
		SourcePayload: json.RawMessage(`{"message":1}`), Text: text,
	}
}
