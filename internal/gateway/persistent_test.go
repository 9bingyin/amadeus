package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
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

func persistentMessage(eventID, text string) Message {
	return Message{
		Platform: "test", AccountID: "account", ConversationID: "chat", SenderID: "user",
		SourceNamespace: "test:account", SourceEventID: eventID,
		SourcePayload: json.RawMessage(`{"message":1}`), Text: text,
	}
}
