package conversation

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
)

func TestStoreFixedInputWindowKeepsMessagesSeparate(t *testing.T) {
	store := openTestStore(t)
	now := time.Unix(1_700_000_000, 0).UTC()
	store.now = func() time.Time { return now }
	input := testAcceptInput(t, "update-1", "chat-1", "")
	input.Run.InputWindow = 700 * time.Millisecond
	first, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() first error = %v", err)
	}
	if started, err := store.StartNextRun(t.Context()); err != nil || started != nil {
		t.Fatalf("StartNextRun() before deadline = %#v, %v", started, err)
	}

	now = now.Add(699 * time.Millisecond)
	input = testAcceptInput(t, "update-2", "chat-1", "")
	input.Message, err = EncodeMessage(sdk.UserMessage("second"))
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	input.Run.InputWindow = 700 * time.Millisecond
	second, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() second error = %v", err)
	}
	if second.RunID != first.RunID {
		t.Fatalf("second run = %s, want %s", second.RunID, first.RunID)
	}

	now = now.Add(time.Millisecond)
	started, err := store.StartNextRun(t.Context())
	if err != nil {
		t.Fatalf("StartNextRun() at deadline error = %v", err)
	}
	if started == nil || started.ID != first.RunID {
		t.Fatalf("started = %#v", started)
	}
	history, err := store.History(t.Context(), first.ConversationID)
	if err != nil {
		t.Fatalf("History() error = %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	if got := []string{
		history[0].Content[0].(sdk.TextPart).Text,
		history[1].Content[0].(sdk.TextPart).Text,
	}; got[0] != "hello" || got[1] != "second" {
		t.Fatalf("user messages = %#v", got)
	}
}

func TestStoreRunningInputWindowDoesNotSlide(t *testing.T) {
	store := openTestStore(t)
	now := time.Unix(1_700_000_000, 0).UTC()
	store.now = func() time.Time { return now }
	input := testAcceptInput(t, "update-1", "chat-1", "")
	input.Run.InputWindow = 700 * time.Millisecond
	accepted, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() first error = %v", err)
	}
	now = now.Add(700 * time.Millisecond)
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}

	now = now.Add(200 * time.Millisecond)
	secondInput := testAcceptInput(t, "update-2", "chat-1", "")
	secondInput.Run.InputWindow = 700 * time.Millisecond
	second, err := store.Accept(t.Context(), secondInput)
	if err != nil {
		t.Fatalf("Accept() second error = %v", err)
	}
	if !second.InterruptRequested || second.InputRevision != 2 {
		t.Fatalf("second acceptance = %#v", second)
	}
	prepared, err := store.PrepareInput(t.Context(), accepted.RunID)
	if err != nil {
		t.Fatalf("PrepareInput() before deadline error = %v", err)
	}
	if prepared.Ready || !prepared.ReadyAt.Equal(now.Add(700*time.Millisecond)) {
		t.Fatalf("prepared before deadline = %#v", prepared)
	}

	now = now.Add(600 * time.Millisecond)
	thirdInput := testAcceptInput(t, "update-3", "chat-1", "")
	thirdInput.Message, err = EncodeMessage(sdk.UserMessage("third"))
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	thirdInput.Run.InputWindow = 700 * time.Millisecond
	third, err := store.Accept(t.Context(), thirdInput)
	if err != nil {
		t.Fatalf("Accept() third error = %v", err)
	}
	if third.InputRevision != 3 {
		t.Fatalf("third revision = %d, want 3", third.InputRevision)
	}

	now = now.Add(100 * time.Millisecond)
	prepared, err = store.PrepareInput(t.Context(), accepted.RunID)
	if err != nil {
		t.Fatalf("PrepareInput() at original deadline error = %v", err)
	}
	if !prepared.Ready || prepared.InputRevision != 3 || len(prepared.Messages) != 2 {
		t.Fatalf("prepared at deadline = %#v", prepared)
	}
}

func TestStoreResponseAdmissionRejectsStaleInputRevision(t *testing.T) {
	store := openTestStore(t)
	first, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() first error = %v", err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	admitted, err := store.AdmitResponse(t.Context(), first.RunID, 1, 1)
	if err != nil || !admitted {
		t.Fatalf("AdmitResponse() current = %v, %v", admitted, err)
	}
	second, err := store.Accept(t.Context(), testAcceptInput(t, "update-2", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() second error = %v", err)
	}
	if second.InputRevision != 2 || !second.InterruptRequested {
		t.Fatalf("second acceptance = %#v", second)
	}
	admitted, err = store.AdmitResponse(t.Context(), first.RunID, 2, 1)
	if err != nil {
		t.Fatalf("AdmitResponse() stale error = %v", err)
	}
	if admitted {
		t.Fatal("stale response was admitted")
	}
}

func TestStoreDoesNotFailStaleRequestAfterNewInput(t *testing.T) {
	store := openTestStore(t)
	first, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() first error = %v", err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	if _, err := store.Accept(t.Context(), testAcceptInput(t, "update-2", "chat-1", "")); err != nil {
		t.Fatalf("Accept() second error = %v", err)
	}
	failed, err := store.FailRunIfInputRevision(
		t.Context(), first.RunID, "provider_error", "old failure",
		staticOutbox(OutboxChunk{Kind: "error", Payload: json.RawMessage(`{}`)}), 1,
	)
	if err != nil {
		t.Fatalf("FailRunIfInputRevision() error = %v", err)
	}
	if failed {
		t.Fatal("stale request failure terminated the run")
	}
	outcome, err := store.RunOutcome(t.Context(), first.RunID)
	if err != nil {
		t.Fatalf("RunOutcome() error = %v", err)
	}
	if outcome.Status != "running" {
		t.Fatalf("run status = %q, want running", outcome.Status)
	}
}

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
	if committed.StepSeq != 0 || committed.Sealed {
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
	if committed.Sealed {
		t.Fatalf("suppressed commit = %#v", committed)
	}
	prepared, err := store.PrepareInput(t.Context(), first.RunID)
	if err != nil {
		t.Fatalf("PrepareInput() error = %v", err)
	}
	if !prepared.Ready || len(prepared.Messages) != 1 {
		t.Fatalf("prepared input = %#v", prepared)
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
