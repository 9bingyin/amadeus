package conversation

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
)

func TestRebuildProjectionsRestoresHistoryRunAndOutbox(t *testing.T) {
	store := openTestStore(t)
	input := testAcceptInput(t, "update-1", "chat-1", "")
	accepted, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	step := &sdk.StepResult{
		Text: "done", FinishReason: sdk.FinishReasonStop,
		Messages: []sdk.Message{sdk.AssistantMessage("done")},
	}
	if _, err := store.CommitStep(t.Context(), CommitStepInput{
		RunID: accepted.RunID, Step: step, Final: true,
		PlanOutbox: staticOutbox(OutboxChunk{Kind: "final", Payload: json.RawMessage(`{"text":"done"}`)}),
	}); err != nil {
		t.Fatalf("CommitStep() error = %v", err)
	}
	pending, err := store.PendingOutbox(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(pending) != 1 {
		t.Fatalf("PendingOutbox() = %#v, %v", pending, err)
	}
	if _, err := store.StartDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("StartDelivery() error = %v", err)
	}
	if err := store.CompleteDelivery(t.Context(), pending[0].ID); err != nil {
		t.Fatalf("CompleteDelivery() error = %v", err)
	}
	recordsBefore, err := store.Records(t.Context())
	if err != nil {
		t.Fatalf("Records() before error = %v", err)
	}

	if err := store.RebuildProjections(t.Context()); err != nil {
		t.Fatalf("RebuildProjections() error = %v", err)
	}
	recordsAfter, err := store.Records(t.Context())
	if err != nil {
		t.Fatalf("Records() after error = %v", err)
	}
	if len(recordsAfter) != len(recordsBefore) {
		t.Fatalf("record count after rebuild = %d, want %d", len(recordsAfter), len(recordsBefore))
	}
	history, err := store.History(t.Context(), accepted.ConversationID)
	if err != nil {
		t.Fatalf("History() error = %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	run, err := conversationdb.New(store.database).GetRun(t.Context(), accepted.RunID)
	if err != nil {
		t.Fatalf("GetRun() error = %v", err)
	}
	if run.Status != "completed" || run.NextStepSeq != 1 {
		t.Fatalf("rebuilt run = %#v", run)
	}
	outbox, err := conversationdb.New(store.database).GetOutbox(t.Context(), pending[0].ID)
	if err != nil {
		t.Fatalf("GetOutbox() error = %v", err)
	}
	if outbox.Status != "sent" || outbox.Attempts != 1 {
		t.Fatalf("rebuilt outbox = %#v", outbox)
	}
	duplicate, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() duplicate after rebuild error = %v", err)
	}
	if !duplicate.Duplicate || duplicate.MessageRecordID != accepted.MessageRecordID {
		t.Fatalf("duplicate after rebuild = %#v", duplicate)
	}
}

func TestRebuildProjectionsPreservesInputWindow(t *testing.T) {
	store := openTestStore(t)
	now := time.Unix(1_700_000_000, 0).UTC()
	store.now = func() time.Time { return now }
	input := testAcceptInput(t, "update-1", "chat-1", "")
	input.Run.InputWindow = 700 * time.Millisecond
	accepted, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if err := store.RebuildProjections(t.Context()); err != nil {
		t.Fatalf("RebuildProjections() error = %v", err)
	}
	if started, err := store.StartNextRun(t.Context()); err != nil || started != nil {
		t.Fatalf("StartNextRun() before rebuilt deadline = %#v, %v", started, err)
	}
	now = now.Add(700 * time.Millisecond)
	started, err := store.StartNextRun(t.Context())
	if err != nil {
		t.Fatalf("StartNextRun() at rebuilt deadline error = %v", err)
	}
	if started == nil || started.ID != accepted.RunID {
		t.Fatalf("started = %#v", started)
	}
	run, err := conversationdb.New(store.database).GetRun(t.Context(), accepted.RunID)
	if err != nil {
		t.Fatalf("GetRun() error = %v", err)
	}
	if run.InputRevision != 1 || run.HandledInputRevision != 1 || run.InputNotBeforeMs.Valid {
		t.Fatalf("rebuilt input state = %#v", run)
	}
}

func TestRebuildProjectionsPreservesQueuedPendingMessage(t *testing.T) {
	store := openTestStore(t)
	accepted, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if err := store.RebuildProjections(t.Context()); err != nil {
		t.Fatalf("RebuildProjections() error = %v", err)
	}
	started, err := store.StartNextRun(t.Context())
	if err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	if started == nil || started.ID != accepted.RunID {
		t.Fatalf("started = %#v", started)
	}
	history, err := store.History(t.Context(), accepted.ConversationID)
	if err != nil {
		t.Fatalf("History() error = %v", err)
	}
	if len(history) != 1 || history[0].Role != sdk.MessageRoleUser {
		t.Fatalf("history = %#v", history)
	}
}
