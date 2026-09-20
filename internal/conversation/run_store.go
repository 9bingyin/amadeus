package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
)

var ErrRunNotRunning = errors.New("run is not running")

type RunOutcome struct {
	Status       string
	Reply        string
	ErrorCode    string
	ErrorMessage string
}

type StartedRun struct {
	ID              string
	ConversationID  string
	Provider        string
	Model           string
	ReasoningEffort string
	SystemPrompt    string
	Config          json.RawMessage
}

type OutboxChunk struct {
	Kind    string
	Payload json.RawMessage
}

type FinalReply struct {
	Route              Route
	MessageRecordID    string
	ReplyToRecordID    string
	ReplySourcePayload json.RawMessage
	Kind               string
	Text               string
}

type OutboxPlanner func(FinalReply) ([]OutboxChunk, error)

type CommitStepInput struct {
	RunID      string
	Step       *sdk.StepResult
	Final      bool
	PlanOutbox OutboxPlanner
}

type CommitStepResult struct {
	StepSeq         int64
	NewUserMessages []sdk.Message
	Sealed          bool
}

type PendingOutbox struct {
	ID              string
	ConversationID  string
	RunID           string
	MessageRecordID string
	ReplyToRecordID string
	Kind            string
	ChunkIndex      int
	ChunkCount      int
	Attempts        int64
	Payload         json.RawMessage
}

func (s *Store) RunOutcome(ctx context.Context, runID string) (RunOutcome, error) {
	queries := conversationdb.New(s.database)
	run, err := queries.GetRun(ctx, runID)
	if err != nil {
		return RunOutcome{}, fmt.Errorf("load run outcome: %w", err)
	}
	outcome := RunOutcome{
		Status: run.Status, ErrorCode: run.ErrorCode.String, ErrorMessage: run.ErrorMessage.String,
	}
	if run.Status != "completed" {
		return outcome, nil
	}
	payload, err := queries.GetLatestRunAssistantPayload(ctx, runID)
	if err != nil {
		return RunOutcome{}, fmt.Errorf("load final assistant message: %w", err)
	}
	var stored MessageRecordPayload
	if err := json.Unmarshal([]byte(payload), &stored); err != nil {
		return RunOutcome{}, fmt.Errorf("decode final assistant message: %w", err)
	}
	var reply strings.Builder
	for _, part := range stored.Message.Parts {
		if part.Type == PartTypeText && part.Text != nil {
			reply.WriteString(part.Text.Text)
		}
	}
	outcome.Reply = reply.String()
	return outcome, nil
}

func (s *Store) StartNextRun(ctx context.Context) (*StartedRun, error) {
	commitID, err := s.newID()
	if err != nil {
		return nil, fmt.Errorf("generate run start commit ID: %w", err)
	}
	startRecordID, err := s.newID()
	if err != nil {
		return nil, fmt.Errorf("generate run start record ID: %w", err)
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin starting run: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	if _, err := queries.GetRunningRun(ctx); err == nil {
		return nil, errors.New("another run is already running")
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("find running run: %w", err)
	}
	run, err := queries.GetNextQueuedRun(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find next queued run: %w", err)
	}
	now := s.now().UTC()
	rows, err := queries.StartRun(ctx, conversationdb.StartRunParams{
		StartedAtMs: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: run.ID,
	})
	if err != nil {
		return nil, fmt.Errorf("start run: %w", err)
	}
	if rows != 1 {
		return nil, fmt.Errorf("start run %s: state changed", run.ID)
	}
	payload, err := json.Marshal(RunStatusPayload{Status: "running"})
	if err != nil {
		return nil, fmt.Errorf("encode run start record: %w", err)
	}
	record, err := newRecord(startRecordID, commitID, RecordKindRunStarted, payload, now)
	if err != nil {
		return nil, err
	}
	record.ConversationID = run.ConversationID
	record.RunID = run.ID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return nil, err
	}
	if _, _, err := s.commitPendingMessages(ctx, queries, run.ID, run.ConversationID, commitID, now); err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("commit starting run: %w", err)
	}
	return &StartedRun{
		ID: run.ID, ConversationID: run.ConversationID, Provider: run.Provider, Model: run.Model,
		ReasoningEffort: run.ReasoningEffort.String, SystemPrompt: run.SystemPrompt,
		Config: json.RawMessage(run.ConfigJson.String),
	}, nil
}

func (s *Store) History(ctx context.Context, conversationID string) ([]sdk.Message, error) {
	rows, err := conversationdb.New(s.database).ListConversationHistory(ctx, conversationID)
	if err != nil {
		return nil, fmt.Errorf("list conversation history: %w", err)
	}
	messages := make([]sdk.Message, 0, len(rows))
	for _, row := range rows {
		message, decodeErr := s.decodeStoredMessage(ctx, row.PayloadJson, row.SchemaVersion)
		if decodeErr != nil {
			return nil, fmt.Errorf("decode history message %s: %w", row.RecordID, decodeErr)
		}
		messages = append(messages, message)
	}
	return messages, nil
}

func (s *Store) CommitPending(ctx context.Context, runID string) ([]sdk.Message, error) {
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin committing pending messages: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	run, err := queries.GetRun(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("load pending run: %w", err)
	}
	if run.Status != "running" {
		return nil, fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	commitID, err := s.newID()
	if err != nil {
		return nil, fmt.Errorf("generate pending commit ID: %w", err)
	}
	pending, _, err := s.commitPendingMessages(
		ctx, queries, run.ID, run.ConversationID, commitID, s.now().UTC(),
	)
	if err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("commit pending messages: %w", err)
	}
	messages := make([]sdk.Message, 0, len(pending))
	for _, row := range pending {
		message, decodeErr := s.decodeStoredMessage(ctx, row.PayloadJson, row.SchemaVersion)
		if decodeErr != nil {
			return nil, fmt.Errorf("decode pending message %s: %w", row.RecordID, decodeErr)
		}
		messages = append(messages, message)
	}
	return messages, nil
}

func (s *Store) CommitStep(ctx context.Context, input CommitStepInput) (CommitStepResult, error) {
	if input.RunID == "" {
		return CommitStepResult{}, errors.New("run ID is required")
	}
	if input.Step == nil || len(input.Step.Messages) == 0 {
		return CommitStepResult{}, errors.New("committed step has no messages")
	}
	if !input.Final && input.PlanOutbox != nil {
		return CommitStepResult{}, errors.New("non-final step cannot plan outbox messages")
	}
	for _, message := range input.Step.Messages {
		if message.Role == sdk.MessageRoleUser {
			return CommitStepResult{}, errors.New("committed step cannot contain user messages")
		}
	}
	commitID, err := s.newID()
	if err != nil {
		return CommitStepResult{}, fmt.Errorf("generate step commit ID: %w", err)
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return CommitStepResult{}, fmt.Errorf("begin committing step: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	run, err := queries.GetRun(ctx, input.RunID)
	if err != nil {
		return CommitStepResult{}, fmt.Errorf("load committed run: %w", err)
	}
	if run.Status != "running" {
		return CommitStepResult{}, fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	stepSeq, err := queries.AdvanceRunStep(ctx, run.ID)
	if err != nil {
		return CommitStepResult{}, fmt.Errorf("reserve step sequence: %w", err)
	}
	encodedMessages, err := EncodeStep(stepSeq, input.Step)
	if err != nil {
		return CommitStepResult{}, fmt.Errorf("encode committed step: %w", err)
	}
	pending, err := queries.ListPendingRunMessages(ctx, run.ID)
	if err != nil {
		return CommitStepResult{}, fmt.Errorf("list pending run messages: %w", err)
	}
	now := s.now().UTC()
	nowMS := now.UnixMilli()
	firstHistorySeq, err := queries.ReserveHistoryRange(ctx, conversationdb.ReserveHistoryRangeParams{
		Count: int64(len(encodedMessages) + len(pending)), UpdatedAtMs: nowMS, ConversationID: run.ConversationID,
	})
	if err != nil {
		return CommitStepResult{}, fmt.Errorf("reserve history sequence: %w", err)
	}

	messageRecordIDs := make([]string, len(encodedMessages))
	for index, encoded := range encodedMessages {
		recordID, idErr := s.newID()
		if idErr != nil {
			return CommitStepResult{}, fmt.Errorf("generate step message record ID: %w", idErr)
		}
		messageRecordIDs[index] = recordID
		stepMessageSeq := int64(index)
		payload, marshalErr := json.Marshal(MessageRecordPayload{
			Message: encoded.Message, StepSeq: &stepSeq, StepMessageSeq: &stepMessageSeq,
		})
		if marshalErr != nil {
			return CommitStepResult{}, fmt.Errorf("encode step message record: %w", marshalErr)
		}
		record, recordErr := newRecord(recordID, commitID, RecordKindMessageCreated, payload, now)
		if recordErr != nil {
			return CommitStepResult{}, recordErr
		}
		record.ConversationID = run.ConversationID
		record.RunID = run.ID
		if _, appendErr := appendRecord(ctx, queries, record); appendErr != nil {
			return CommitStepResult{}, appendErr
		}
		if blobErr := insertBlobs(ctx, queries, recordID, encoded.Blobs, nowMS); blobErr != nil {
			return CommitStepResult{}, blobErr
		}
		if insertErr := queries.InsertMessage(ctx, conversationdb.InsertMessageParams{
			RecordID: recordID, ConversationID: run.ConversationID, RunID: run.ID,
			Role:           encoded.Message.Role,
			HistorySeq:     sql.NullInt64{Int64: firstHistorySeq + int64(index), Valid: true},
			StepSeq:        sql.NullInt64{Int64: stepSeq, Valid: true},
			StepMessageSeq: sql.NullInt64{Int64: stepMessageSeq, Valid: true},
			CommittedAtMs:  sql.NullInt64{Int64: nowMS, Valid: true},
		}); insertErr != nil {
			return CommitStepResult{}, fmt.Errorf("insert step message %d: %w", index, insertErr)
		}
	}
	for index, pendingMessage := range pending {
		updated, updateErr := queries.CommitMessageToHistory(ctx, conversationdb.CommitMessageToHistoryParams{
			HistorySeq:    sql.NullInt64{Int64: firstHistorySeq + int64(len(encodedMessages)+index), Valid: true},
			CommittedAtMs: sql.NullInt64{Int64: nowMS, Valid: true}, RecordID: pendingMessage.RecordID,
		})
		if updateErr != nil {
			return CommitStepResult{}, fmt.Errorf("commit pending message %s: %w", pendingMessage.RecordID, updateErr)
		}
		if updated != 1 {
			return CommitStepResult{}, fmt.Errorf("commit pending message %s: state changed", pendingMessage.RecordID)
		}
	}
	allHistoryIDs := append(append([]string(nil), messageRecordIDs...), pendingRecordIDs(pending)...)
	if err := s.appendStepFacts(ctx, queries, run, commitID, now, stepSeq, messageRecordIDs, allHistoryIDs, firstHistorySeq, input.Final); err != nil {
		return CommitStepResult{}, err
	}

	sealed := input.Final && len(pending) == 0
	if sealed {
		if input.PlanOutbox == nil {
			return CommitStepResult{}, errors.New("sealing a run requires an outbox planner")
		}
		if err := s.sealRun(ctx, queries, run, commitID, now, messageRecordIDs, input.Step.Text, input.PlanOutbox); err != nil {
			return CommitStepResult{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return CommitStepResult{}, fmt.Errorf("commit agent step: %w", err)
	}
	newUserMessages := make([]sdk.Message, 0, len(pending))
	for _, pendingMessage := range pending {
		message, decodeErr := s.decodeStoredMessage(ctx, pendingMessage.PayloadJson, pendingMessage.SchemaVersion)
		if decodeErr != nil {
			return CommitStepResult{}, fmt.Errorf("decode committed user message %s: %w", pendingMessage.RecordID, decodeErr)
		}
		newUserMessages = append(newUserMessages, message)
	}
	return CommitStepResult{StepSeq: stepSeq, NewUserMessages: newUserMessages, Sealed: sealed}, nil
}

func (s *Store) FailRun(
	ctx context.Context,
	runID, code, message string,
	planOutbox OutboxPlanner,
) error {
	if planOutbox == nil {
		return errors.New("failing a run requires an outbox planner")
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin failing run: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	run, err := queries.GetRun(ctx, runID)
	if err != nil {
		return fmt.Errorf("load failed run: %w", err)
	}
	if run.Status != "running" {
		return fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	now := s.now().UTC()
	updated, err := queries.SetRunTerminal(ctx, conversationdb.SetRunTerminalParams{
		Status: "failed", ErrorCode: nullableString(code), ErrorMessage: nullableString(message),
		FinishedAtMs: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: run.ID,
	})
	if err != nil {
		return fmt.Errorf("fail run: %w", err)
	}
	if updated != 1 {
		return fmt.Errorf("fail run %s: state changed", run.ID)
	}
	commitID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate failed run commit ID: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate failed run record ID: %w", err)
	}
	statusPayload, err := json.Marshal(RunStatusPayload{Status: "failed", ErrorCode: code, ErrorMessage: message})
	if err != nil {
		return fmt.Errorf("encode failed run record: %w", err)
	}
	statusRecord, err := newRecord(recordID, commitID, RecordKindRunFailed, statusPayload, now)
	if err != nil {
		return err
	}
	statusRecord.ConversationID = run.ConversationID
	statusRecord.RunID = run.ID
	if _, err := appendRecord(ctx, queries, statusRecord); err != nil {
		return err
	}
	if err := s.enqueueOutbox(ctx, queries, run, commitID, now, "", "error", message, planOutbox); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit failed run: %w", err)
	}
	return nil
}

func (s *Store) NextOutboxAt(ctx context.Context) (time.Time, bool, error) {
	const query = `
SELECT MIN(o.available_at_ms)
FROM outbox o
WHERE o.status = 'pending'
  AND NOT EXISTS (
      SELECT 1 FROM outbox earlier
      WHERE earlier.conversation_id = o.conversation_id
        AND earlier.status = 'pending'
        AND earlier.enqueue_seq < o.enqueue_seq
  )`
	var available sql.NullInt64
	if err := s.database.QueryRowContext(ctx, query).Scan(&available); err != nil {
		return time.Time{}, false, fmt.Errorf("find next outbox time: %w", err)
	}
	if !available.Valid {
		return time.Time{}, false, nil
	}
	return time.UnixMilli(available.Int64), true, nil
}

func (s *Store) PendingOutbox(ctx context.Context, now time.Time) ([]PendingOutbox, error) {
	rows, err := conversationdb.New(s.database).ListPendingOutboxHeads(ctx, now.UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("list pending outbox: %w", err)
	}
	pending := make([]PendingOutbox, len(rows))
	for index, row := range rows {
		var payload OutboxPlannedPayload
		if err := json.Unmarshal([]byte(row.PayloadJson), &payload); err != nil {
			return nil, fmt.Errorf("decode outbox %s: %w", row.ID, err)
		}
		pending[index] = PendingOutbox{
			ID: row.ID, ConversationID: row.ConversationID, RunID: row.RunID,
			MessageRecordID: row.MessageRecordID.String, ReplyToRecordID: row.ReplyToRecordID.String,
			Kind: row.Kind, ChunkIndex: int(row.ChunkIndex), ChunkCount: int(row.ChunkCount),
			Attempts: row.Attempts, Payload: append(json.RawMessage(nil), payload.Payload...),
		}
	}
	return pending, nil
}

func (s *Store) StartDelivery(ctx context.Context, outboxID string) (int64, error) {
	return s.recordDelivery(ctx, outboxID, RecordKindDeliveryStarted, func(
		queries *conversationdb.Queries, row conversationdb.GetOutboxRow, now time.Time,
	) (DeliveryPayload, error) {
		updated, err := queries.MarkOutboxAttempt(ctx, outboxID)
		if err != nil {
			return DeliveryPayload{}, fmt.Errorf("mark outbox attempt: %w", err)
		}
		if updated != 1 {
			return DeliveryPayload{}, errors.New("outbox message is not pending")
		}
		return DeliveryPayload{OutboxID: outboxID, Attempt: row.Attempts + 1}, nil
	})
}

func (s *Store) CompleteDelivery(ctx context.Context, outboxID string) error {
	_, err := s.recordDelivery(ctx, outboxID, RecordKindDeliverySent, func(
		queries *conversationdb.Queries, row conversationdb.GetOutboxRow, now time.Time,
	) (DeliveryPayload, error) {
		updated, err := queries.MarkOutboxSent(ctx, conversationdb.MarkOutboxSentParams{
			SentAtMs: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: outboxID,
		})
		if err != nil {
			return DeliveryPayload{}, fmt.Errorf("mark outbox sent: %w", err)
		}
		if updated != 1 {
			return DeliveryPayload{}, errors.New("outbox message is not pending")
		}
		return DeliveryPayload{OutboxID: outboxID, Attempt: row.Attempts}, nil
	})
	return err
}

func (s *Store) FailDelivery(ctx context.Context, outboxID, message string, retryAt time.Time, dead bool) error {
	_, err := s.recordDelivery(ctx, outboxID, RecordKindDeliveryFailed, func(
		queries *conversationdb.Queries, row conversationdb.GetOutboxRow, _ time.Time,
	) (DeliveryPayload, error) {
		var updated int64
		var updateErr error
		if dead {
			updated, updateErr = queries.MarkOutboxDead(ctx, conversationdb.MarkOutboxDeadParams{
				LastError: nullableString(message), ID: outboxID,
			})
		} else {
			updated, updateErr = queries.RescheduleOutbox(ctx, conversationdb.RescheduleOutboxParams{
				AvailableAtMs: retryAt.UnixMilli(), LastError: nullableString(message), ID: outboxID,
			})
		}
		if updateErr != nil {
			return DeliveryPayload{}, fmt.Errorf("record outbox failure: %w", updateErr)
		}
		if updated != 1 {
			return DeliveryPayload{}, errors.New("outbox message is not pending")
		}
		return DeliveryPayload{
			OutboxID: outboxID, Attempt: row.Attempts, Error: message,
			RetryAtMS: retryAt.UnixMilli(), Dead: dead,
		}, nil
	})
	return err
}

func (s *Store) Recover(ctx context.Context, planOutbox OutboxPlanner) ([]string, error) {
	if planOutbox == nil {
		return nil, errors.New("state recovery requires an outbox planner")
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin state recovery: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	now := s.now().UTC()
	runs, err := queries.InterruptRunningRuns(ctx, sql.NullInt64{Int64: now.UnixMilli(), Valid: true})
	if err != nil {
		return nil, fmt.Errorf("interrupt running runs: %w", err)
	}
	interrupted := make([]string, len(runs))
	for index, run := range runs {
		commitID, idErr := s.newID()
		if idErr != nil {
			return nil, fmt.Errorf("generate recovery commit ID: %w", idErr)
		}
		recordID, idErr := s.newID()
		if idErr != nil {
			return nil, fmt.Errorf("generate recovery record ID: %w", idErr)
		}
		payload, marshalErr := json.Marshal(RunStatusPayload{
			Status: "interrupted", ErrorCode: "process_restart",
			ErrorMessage: "agent process stopped before the run completed",
		})
		if marshalErr != nil {
			return nil, fmt.Errorf("encode recovery record: %w", marshalErr)
		}
		record, recordErr := newRecord(recordID, commitID, RecordKindRunInterrupted, payload, now)
		if recordErr != nil {
			return nil, recordErr
		}
		record.ConversationID = run.ConversationID
		record.RunID = run.ID
		if _, appendErr := appendRecord(ctx, queries, record); appendErr != nil {
			return nil, appendErr
		}
		if outboxErr := s.enqueueOutbox(
			ctx, queries, run, commitID, now, "", "error",
			"agent process stopped before the run completed", planOutbox,
		); outboxErr != nil {
			return nil, outboxErr
		}
		interrupted[index] = run.ID
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("commit state recovery: %w", err)
	}
	return interrupted, nil
}

func (s *Store) commitPendingMessages(
	ctx context.Context,
	queries *conversationdb.Queries,
	runID, conversationID, commitID string,
	now time.Time,
) ([]conversationdb.ListPendingRunMessagesRow, int64, error) {
	pending, err := queries.ListPendingRunMessages(ctx, runID)
	if err != nil {
		return nil, 0, fmt.Errorf("list pending run messages: %w", err)
	}
	if len(pending) == 0 {
		return pending, 0, nil
	}
	first, err := queries.ReserveHistoryRange(ctx, conversationdb.ReserveHistoryRangeParams{
		Count: int64(len(pending)), UpdatedAtMs: now.UnixMilli(), ConversationID: conversationID,
	})
	if err != nil {
		return nil, 0, fmt.Errorf("reserve pending history sequence: %w", err)
	}
	for index, message := range pending {
		updated, updateErr := queries.CommitMessageToHistory(ctx, conversationdb.CommitMessageToHistoryParams{
			HistorySeq:    sql.NullInt64{Int64: first + int64(index), Valid: true},
			CommittedAtMs: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, RecordID: message.RecordID,
		})
		if updateErr != nil {
			return nil, 0, fmt.Errorf("commit pending message %s: %w", message.RecordID, updateErr)
		}
		if updated != 1 {
			return nil, 0, fmt.Errorf("commit pending message %s: state changed", message.RecordID)
		}
	}
	if err := s.appendHistoryFact(ctx, queries, runID, conversationID, commitID, now, first, pendingRecordIDs(pending)); err != nil {
		return nil, 0, err
	}
	return pending, first, nil
}

func (s *Store) appendStepFacts(
	ctx context.Context,
	queries *conversationdb.Queries,
	run conversationdb.Run,
	commitID string,
	now time.Time,
	stepSeq int64,
	stepMessageIDs, historyMessageIDs []string,
	firstHistorySeq int64,
	final bool,
) error {
	stepRecordID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate step record ID: %w", err)
	}
	payload, err := json.Marshal(StepCommittedPayload{
		StepSeq: stepSeq, MessageRecordIDs: stepMessageIDs, Final: final,
	})
	if err != nil {
		return fmt.Errorf("encode step record: %w", err)
	}
	record, err := newRecord(stepRecordID, commitID, RecordKindStepCommitted, payload, now)
	if err != nil {
		return err
	}
	record.ConversationID = run.ConversationID
	record.RunID = run.ID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return err
	}
	return s.appendHistoryFact(
		ctx, queries, run.ID, run.ConversationID, commitID, now, firstHistorySeq, historyMessageIDs,
	)
}

func (s *Store) appendHistoryFact(
	ctx context.Context,
	queries *conversationdb.Queries,
	runID, conversationID, commitID string,
	now time.Time,
	firstHistorySeq int64,
	messageRecordIDs []string,
) error {
	recordID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate history record ID: %w", err)
	}
	payload, err := json.Marshal(HistoryAppendedPayload{
		FirstHistorySeq: firstHistorySeq, MessageRecordIDs: messageRecordIDs,
	})
	if err != nil {
		return fmt.Errorf("encode history record: %w", err)
	}
	record, err := newRecord(recordID, commitID, RecordKindHistoryAppended, payload, now)
	if err != nil {
		return err
	}
	record.ConversationID = conversationID
	record.RunID = runID
	_, err = appendRecord(ctx, queries, record)
	return err
}

func (s *Store) sealRun(
	ctx context.Context,
	queries *conversationdb.Queries,
	run conversationdb.Run,
	commitID string,
	now time.Time,
	messageRecordIDs []string,
	text string,
	planOutbox OutboxPlanner,
) error {
	updated, err := queries.SetRunTerminal(ctx, conversationdb.SetRunTerminalParams{
		Status: "completed", FinishedAtMs: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: run.ID,
	})
	if err != nil {
		return fmt.Errorf("complete run: %w", err)
	}
	if updated != 1 {
		return fmt.Errorf("complete run %s: state changed", run.ID)
	}
	statusRecordID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate completed run record ID: %w", err)
	}
	statusPayload, err := json.Marshal(RunStatusPayload{Status: "completed"})
	if err != nil {
		return fmt.Errorf("encode completed run record: %w", err)
	}
	statusRecord, err := newRecord(statusRecordID, commitID, RecordKindRunCompleted, statusPayload, now)
	if err != nil {
		return err
	}
	statusRecord.ConversationID = run.ConversationID
	statusRecord.RunID = run.ID
	if _, err := appendRecord(ctx, queries, statusRecord); err != nil {
		return err
	}
	finalMessageID := ""
	if len(messageRecordIDs) > 0 {
		finalMessageID = messageRecordIDs[0]
	}
	return s.enqueueOutbox(
		ctx, queries, run, commitID, now, finalMessageID, "final", text, planOutbox,
	)
}

func (s *Store) enqueueOutbox(
	ctx context.Context,
	queries *conversationdb.Queries,
	run conversationdb.Run,
	commitID string,
	now time.Time,
	messageRecordID, kind, text string,
	planOutbox OutboxPlanner,
) error {
	latestUser, err := queries.GetLatestRunUserMessage(ctx, run.ID)
	if err != nil {
		return fmt.Errorf("find %s reply target: %w", kind, err)
	}
	conversation, err := queries.GetConversation(ctx, run.ConversationID)
	if err != nil {
		return fmt.Errorf("load %s conversation: %w", kind, err)
	}
	sourceRecord, err := queries.GetRecord(ctx, latestUser.SourceRecordID.String)
	if err != nil {
		return fmt.Errorf("load %s reply source: %w", kind, err)
	}
	chunks, err := planOutbox(FinalReply{
		Route: Route{
			Platform: conversation.Platform, AccountID: conversation.AccountID,
			ChatID: conversation.ExternalChatID, ThreadID: conversation.ExternalThreadID,
		},
		MessageRecordID: messageRecordID, ReplyToRecordID: latestUser.RecordID,
		ReplySourcePayload: json.RawMessage(sourceRecord.PayloadJson), Kind: kind, Text: text,
	})
	if err != nil {
		return fmt.Errorf("plan %s outbox: %w", kind, err)
	}
	if len(chunks) == 0 {
		return fmt.Errorf("outbox planner returned no %s chunks", kind)
	}
	for index, chunk := range chunks {
		if chunk.Kind != kind || !json.Valid(chunk.Payload) {
			return fmt.Errorf("%s outbox chunk %d is invalid", kind, index)
		}
		outboxID, idErr := s.newID()
		if idErr != nil {
			return fmt.Errorf("generate %s outbox ID: %w", kind, idErr)
		}
		recordID, idErr := s.newID()
		if idErr != nil {
			return fmt.Errorf("generate %s outbox record ID: %w", kind, idErr)
		}
		payload, marshalErr := json.Marshal(OutboxPlannedPayload{
			OutboxID: outboxID, MessageRecordID: messageRecordID, ReplyToRecordID: latestUser.RecordID,
			Kind: chunk.Kind, ChunkIndex: index, ChunkCount: len(chunks), Payload: chunk.Payload,
		})
		if marshalErr != nil {
			return fmt.Errorf("encode %s outbox record: %w", kind, marshalErr)
		}
		record, recordErr := newRecord(recordID, commitID, RecordKindOutboxPlanned, payload, now)
		if recordErr != nil {
			return recordErr
		}
		record.ConversationID = run.ConversationID
		record.RunID = run.ID
		enqueueSeq, appendErr := appendRecord(ctx, queries, record)
		if appendErr != nil {
			return appendErr
		}
		if insertErr := queries.InsertOutbox(ctx, conversationdb.InsertOutboxParams{
			ID: outboxID, RecordID: recordID, EnqueueSeq: enqueueSeq,
			ConversationID: run.ConversationID, RunID: run.ID,
			MessageRecordID: nullableString(messageRecordID), ReplyToRecordID: nullableString(latestUser.RecordID),
			Kind: chunk.Kind, ChunkIndex: int64(index), ChunkCount: int64(len(chunks)),
			AvailableAtMs: now.UnixMilli(), CreatedAtMs: now.UnixMilli(),
		}); insertErr != nil {
			return fmt.Errorf("insert %s outbox chunk %d: %w", kind, index, insertErr)
		}
	}
	return nil
}

func (s *Store) recordDelivery(
	ctx context.Context,
	outboxID string,
	kind RecordKind,
	update func(*conversationdb.Queries, conversationdb.GetOutboxRow, time.Time) (DeliveryPayload, error),
) (int64, error) {
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin delivery update: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	row, err := queries.GetOutbox(ctx, outboxID)
	if err != nil {
		return 0, fmt.Errorf("load outbox message: %w", err)
	}
	now := s.now().UTC()
	payload, err := update(queries, row, now)
	if err != nil {
		return 0, err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("encode delivery record: %w", err)
	}
	commitID, err := s.newID()
	if err != nil {
		return 0, fmt.Errorf("generate delivery commit ID: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return 0, fmt.Errorf("generate delivery record ID: %w", err)
	}
	record, err := newRecord(recordID, commitID, kind, encoded, now)
	if err != nil {
		return 0, err
	}
	record.ConversationID = row.ConversationID
	record.RunID = row.RunID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return 0, err
	}
	if err := transaction.Commit(); err != nil {
		return 0, fmt.Errorf("commit delivery update: %w", err)
	}
	return payload.Attempt, nil
}

func (s *Store) decodeStoredMessage(ctx context.Context, payload string, schemaVersion int64) (sdk.Message, error) {
	if schemaVersion != RecordSchemaVersion {
		return sdk.Message{}, fmt.Errorf("unsupported record schema version %d", schemaVersion)
	}
	var stored MessageRecordPayload
	if err := json.Unmarshal([]byte(payload), &stored); err != nil {
		return sdk.Message{}, err
	}
	return stored.Message.Decode(ctx, func(ctx context.Context, digest BlobDigest) ([]byte, error) {
		return s.LoadBlob(ctx, digest)
	})
}

func pendingRecordIDs(rows []conversationdb.ListPendingRunMessagesRow) []string {
	ids := make([]string, len(rows))
	for index, row := range rows {
		ids[index] = row.RecordID
	}
	return ids
}
