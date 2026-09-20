package conversation

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
)

func TestStoreRunLifecycleAndOutbox(t *testing.T) {
	store := openTestStore(t)
	first, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() first error = %v", err)
	}
	started, err := store.StartNextRun(t.Context())
	if err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	if started == nil || started.ID != first.RunID {
		t.Fatalf("started = %#v, want run %s", started, first.RunID)
	}
	history, err := store.History(t.Context(), first.ConversationID)
	if err != nil {
		t.Fatalf("History() error = %v", err)
	}
	if len(history) != 1 || history[0].Role != sdk.MessageRoleUser {
		t.Fatalf("initial history = %#v", history)
	}

	toolStep := &sdk.StepResult{
		FinishReason: sdk.FinishReasonToolCalls,
		Messages:     []sdk.Message{sdk.AssistantMessage("working")},
	}
	committed, err := store.CommitStep(t.Context(), CommitStepInput{RunID: first.RunID, Step: toolStep})
	if err != nil {
		t.Fatalf("CommitStep() tool error = %v", err)
	}
	if committed.StepSeq != 0 || committed.Sealed || len(committed.NewUserMessages) != 0 {
		t.Fatalf("tool commit = %#v", committed)
	}

	second, err := store.Accept(t.Context(), testAcceptInput(t, "update-2", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() second error = %v", err)
	}
	if second.RunID != first.RunID {
		t.Fatalf("second run = %s, want %s", second.RunID, first.RunID)
	}
	suppressed := &sdk.StepResult{FinishReason: sdk.FinishReasonStop, Messages: []sdk.Message{sdk.AssistantMessage("old final")}}
	committed, err = store.CommitStep(t.Context(), CommitStepInput{
		RunID: first.RunID, Step: suppressed, Final: true,
		PlanOutbox: staticOutbox(OutboxChunk{Kind: "final", Payload: json.RawMessage(`{"text":"old final"}`)}),
	})
	if err != nil {
		t.Fatalf("CommitStep() suppressed final error = %v", err)
	}
	if committed.Sealed || len(committed.NewUserMessages) != 1 {
		t.Fatalf("suppressed commit = %#v", committed)
	}

	final := &sdk.StepResult{FinishReason: sdk.FinishReasonStop, Messages: []sdk.Message{sdk.AssistantMessage("new final")}}
	committed, err = store.CommitStep(t.Context(), CommitStepInput{
		RunID: first.RunID, Step: final, Final: true,
		PlanOutbox: staticOutbox(OutboxChunk{Kind: "final", Payload: json.RawMessage(`{"text":"new final"}`)}),
	})
	if err != nil {
		t.Fatalf("CommitStep() final error = %v", err)
	}
	if !committed.Sealed || committed.StepSeq != 2 {
		t.Fatalf("final commit = %#v", committed)
	}
	history, err = store.History(t.Context(), first.ConversationID)
	if err != nil {
		t.Fatalf("History() final error = %v", err)
	}
	if len(history) != 5 {
		t.Fatalf("history length = %d, want 5", len(history))
	}
	if text := history[2].Content[0].(sdk.TextPart).Text; text != "old final" {
		t.Fatalf("suppressed assistant text = %q", text)
	}
	if text := history[3].Content[0].(sdk.TextPart).Text; text != "hello" {
		t.Fatalf("new user text = %q", text)
	}

	pending, err := store.PendingOutbox(t.Context(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("PendingOutbox() error = %v", err)
	}
	if len(pending) != 1 || string(pending[0].Payload) != `{"text":"new final"}` || pending[0].ReplyToRecordID != second.MessageRecordID {
		t.Fatalf("pending outbox = %#v", pending)
	}
	attempt, err := store.StartDelivery(t.Context(), pending[0].ID)
	if err != nil {
		t.Fatalf("StartDelivery() error = %v", err)
	}
	if attempt != 1 {
		t.Fatalf("attempt = %d, want 1", attempt)
	}
	if err := store.CompleteDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("CompleteDelivery() error = %v", err)
	}
	pending, err = store.PendingOutbox(t.Context(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("PendingOutbox() after send error = %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending after send = %#v", pending)
	}
}

func TestStoreOutboxHeadBlocksLaterChunks(t *testing.T) {
	store := openTestStore(t)
	accepted, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	step := &sdk.StepResult{FinishReason: sdk.FinishReasonStop, Messages: []sdk.Message{sdk.AssistantMessage("done")}}
	_, err = store.CommitStep(t.Context(), CommitStepInput{
		RunID: accepted.RunID, Step: step, Final: true,
		PlanOutbox: staticOutbox(
			OutboxChunk{Kind: "final", Payload: json.RawMessage(`{"text":"one"}`)},
			OutboxChunk{Kind: "final", Payload: json.RawMessage(`{"text":"two"}`)},
		),
	})
	if err != nil {
		t.Fatalf("CommitStep() error = %v", err)
	}
	now := time.Now().Add(time.Minute)
	pending, err := store.PendingOutbox(t.Context(), now)
	if err != nil {
		t.Fatalf("PendingOutbox() error = %v", err)
	}
	if len(pending) != 1 || pending[0].ChunkIndex != 0 {
		t.Fatalf("first pending = %#v", pending)
	}
	if _, err := store.StartDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("StartDelivery() error = %v", err)
	}
	if err := store.CompleteDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("CompleteDelivery() error = %v", err)
	}
	pending, err = store.PendingOutbox(t.Context(), now)
	if err != nil {
		t.Fatalf("PendingOutbox() second error = %v", err)
	}
	if len(pending) != 1 || pending[0].ChunkIndex != 1 {
		t.Fatalf("second pending = %#v", pending)
	}
}

func staticOutbox(chunks ...OutboxChunk) OutboxPlanner {
	return func(FinalReply) ([]OutboxChunk, error) {
		return chunks, nil
	}
}

func TestStoreRecoveryInterruptsRunningRun(t *testing.T) {
	store := openTestStore(t)
	accepted, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	interrupted, err := store.Recover(t.Context(), staticOutbox(
		OutboxChunk{Kind: "error", Payload: json.RawMessage(`{"text":"interrupted"}`)},
	))
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if len(interrupted) != 1 || interrupted[0] != accepted.RunID {
		t.Fatalf("interrupted = %#v", interrupted)
	}
	run, err := conversationdb.New(store.database).GetRun(t.Context(), accepted.RunID)
	if err != nil {
		t.Fatalf("GetRun() error = %v", err)
	}
	if run.Status != "interrupted" || run.ErrorCode.String != "process_restart" {
		t.Fatalf("recovered run = %#v", run)
	}
	if next, err := store.StartNextRun(t.Context()); err != nil || next != nil {
		t.Fatalf("StartNextRun() after recovery = %#v, %v", next, err)
	}
}
