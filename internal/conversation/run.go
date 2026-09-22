package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	conversationdb "github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
)

var (
	ErrRunNotRunning       = errors.New("run is not running")
	ErrConversationMissing = errors.New("conversation does not exist")
	ErrConversationBusy    = errors.New("conversation is running")
)

type RunOutcome struct {
	Status       string
	Reply        string
	ErrorCode    string
	ErrorMessage string
}

type StartedRun struct {
	ID              string
	ConversationID  string
	SessionID       string
	Provider        string
	Model           string
	ReasoningEffort string
	SystemPrompt    string
	Config          json.RawMessage
}

type PreparedInput struct {
	Messages           []sdk.Message
	InputRevision      int64
	HistoryThroughSeq  int64
	CheckpointRecordID string
	ReadyAt            time.Time
	Ready              bool
}

type CommitStepInput struct {
	RunID     string
	Step      *sdk.StepResult
	Final     bool
	PlanReply ReplyPlanner
}

type CommitStepResult struct {
	StepSeq int64
	Sealed  bool
}

func (s *Store) ConversationRoute(ctx context.Context, conversationID string) (Route, error) {
	row, err := conversationdb.New(s.database).GetConversation(ctx, conversationID)
	if err != nil {
		return Route{}, fmt.Errorf("load conversation route: %w", err)
	}
	return Route{
		Platform: row.Platform, AccountID: row.AccountID,
		ChatID: row.ExternalChatID, ThreadID: row.ExternalThreadID,
	}, nil
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

func (s *Store) NextQueuedRunAt(ctx context.Context) (time.Time, bool, error) {
	run, err := conversationdb.New(s.database).GetNextQueuedRun(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, fmt.Errorf("find next queued run deadline: %w", err)
	}
	if !run.InputNotBeforeMs.Valid {
		return s.now().UTC(), true, nil
	}
	return time.UnixMilli(run.InputNotBeforeMs.Int64).UTC(), true, nil
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
	if run.InputNotBeforeMs.Valid && run.InputNotBeforeMs.Int64 > now.UnixMilli() {
		return nil, nil
	}
	conversation, err := queries.GetConversation(ctx, run.ConversationID)
	if err != nil {
		return nil, fmt.Errorf("load queued run conversation: %w", err)
	}
	if !run.SessionID.Valid || !conversation.ActiveSessionID.Valid ||
		run.SessionID.String != conversation.ActiveSessionID.String {
		return nil, errors.New("queued run does not belong to active session")
	}
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
	if _, _, err := s.commitPendingMessages(
		ctx, queries, transaction, run.ID, run.ConversationID, commitID, now, run.InputRevision,
	); err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("commit starting run: %w", err)
	}
	s.wakeVectors()
	return &StartedRun{
		ID: run.ID, ConversationID: run.ConversationID, SessionID: run.SessionID.String,
		Provider: run.Provider, Model: run.Model,
		ReasoningEffort: run.ReasoningEffort.String, SystemPrompt: run.SystemPrompt,
		Config: json.RawMessage(run.ConfigJson.String),
	}, nil
}

func (s *Store) InputCurrent(ctx context.Context, runID string, inputRevision int64) (bool, error) {
	run, err := conversationdb.New(s.database).GetRun(ctx, runID)
	if err != nil {
		return false, fmt.Errorf("load request input revision: %w", err)
	}
	if run.Status != "running" {
		return false, fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	return run.InputRevision == inputRevision, nil
}

func (s *Store) AdmitResponse(
	ctx context.Context,
	runID string,
	requestSequence, inputRevision int64,
) (bool, error) {
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin admitting model response: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	run, err := queries.GetRun(ctx, runID)
	if err != nil {
		return false, fmt.Errorf("load response run: %w", err)
	}
	if run.Status != "running" {
		return false, fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	if run.InputRevision != inputRevision {
		return false, nil
	}
	commitID, err := s.newID()
	if err != nil {
		return false, fmt.Errorf("generate response admission commit ID: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return false, fmt.Errorf("generate response admission record ID: %w", err)
	}
	payload, err := json.Marshal(ResponseAdmittedPayload{
		RequestSequence: requestSequence, InputRevision: inputRevision,
	})
	if err != nil {
		return false, fmt.Errorf("encode response admission record: %w", err)
	}
	record, err := newRecord(recordID, commitID, RecordKindResponseAdmitted, payload, s.now().UTC())
	if err != nil {
		return false, err
	}
	record.ConversationID = run.ConversationID
	record.RunID = run.ID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return false, err
	}
	if err := transaction.Commit(); err != nil {
		return false, fmt.Errorf("commit model response admission: %w", err)
	}
	return true, nil
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

func (s *Store) PrepareInput(ctx context.Context, runID string) (PreparedInput, error) {
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return PreparedInput{}, fmt.Errorf("begin preparing input: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	run, err := queries.GetRun(ctx, runID)
	if err != nil {
		return PreparedInput{}, fmt.Errorf("load input run: %w", err)
	}
	if run.Status != "running" {
		return PreparedInput{}, fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	now := s.now().UTC()
	if run.InputNotBeforeMs.Valid && run.InputNotBeforeMs.Int64 > now.UnixMilli() {
		conversation, loadErr := queries.GetConversation(ctx, run.ConversationID)
		if loadErr != nil {
			return PreparedInput{}, fmt.Errorf("load input conversation: %w", loadErr)
		}
		return PreparedInput{
			InputRevision:      run.HandledInputRevision,
			HistoryThroughSeq:  conversation.NextHistorySeq - 1,
			CheckpointRecordID: conversation.ActiveContextCheckpointRecordID.String,
			ReadyAt:            time.UnixMilli(run.InputNotBeforeMs.Int64).UTC(),
		}, nil
	}
	commitID, err := s.newID()
	if err != nil {
		return PreparedInput{}, fmt.Errorf("generate input commit ID: %w", err)
	}
	pending, _, err := s.commitPendingMessages(
		ctx, queries, transaction, run.ID, run.ConversationID, commitID, now, run.InputRevision,
	)
	if err != nil {
		return PreparedInput{}, err
	}
	if run.InputRevision != run.HandledInputRevision || run.InputNotBeforeMs.Valid {
		updated, updateErr := queries.AcknowledgeRunInput(ctx, conversationdb.AcknowledgeRunInputParams{
			ID: run.ID, InputNotBeforeMs: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		})
		if updateErr != nil {
			return PreparedInput{}, fmt.Errorf("acknowledge prepared input: %w", updateErr)
		}
		if updated != 1 {
			return PreparedInput{}, fmt.Errorf("acknowledge prepared input for run %s: state changed", run.ID)
		}
	}
	conversation, err := queries.GetConversation(ctx, run.ConversationID)
	if err != nil {
		return PreparedInput{}, fmt.Errorf("load prepared input conversation: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return PreparedInput{}, fmt.Errorf("commit prepared input: %w", err)
	}
	s.wakeVectors()
	messages := make([]sdk.Message, 0, len(pending))
	for _, row := range pending {
		message, decodeErr := s.decodeStoredMessage(ctx, row.PayloadJson, row.SchemaVersion)
		if decodeErr != nil {
			return PreparedInput{}, fmt.Errorf("decode prepared message %s: %w", row.RecordID, decodeErr)
		}
		messages = append(messages, message)
	}
	return PreparedInput{
		Messages: messages, InputRevision: run.InputRevision,
		HistoryThroughSeq:  conversation.NextHistorySeq - 1,
		CheckpointRecordID: conversation.ActiveContextCheckpointRecordID.String,
		Ready:              true,
	}, nil
}

func (s *Store) CommitStep(ctx context.Context, input CommitStepInput) (CommitStepResult, error) {
	if input.RunID == "" {
		return CommitStepResult{}, errors.New("run ID is required")
	}
	if input.Step == nil || len(input.Step.Messages) == 0 {
		return CommitStepResult{}, errors.New("committed step has no messages")
	}
	if !input.Final && input.PlanReply != nil {
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
	now := s.now().UTC()
	nowMS := now.UnixMilli()
	firstHistorySeq, err := queries.ReserveHistoryRange(ctx, conversationdb.ReserveHistoryRangeParams{
		Count: int64(len(encodedMessages)), UpdatedAtMs: nowMS, ConversationID: run.ConversationID,
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
		if indexErr := indexSearchMessage(ctx, transaction, recordID, run.ConversationID, string(payload)); indexErr != nil {
			return CommitStepResult{}, indexErr
		}
	}
	if err := s.appendStepFacts(
		ctx, queries, run, commitID, now, stepSeq,
		messageRecordIDs, messageRecordIDs, firstHistorySeq, input.Final,
	); err != nil {
		return CommitStepResult{}, err
	}

	sealed := input.Final && run.InputRevision == run.HandledInputRevision && !run.InputNotBeforeMs.Valid
	if sealed {
		if input.PlanReply == nil {
			return CommitStepResult{}, errors.New("sealing a run requires an outbox planner")
		}
		if err := s.sealRun(ctx, queries, run, commitID, now, messageRecordIDs, input.Step.Text, input.PlanReply); err != nil {
			return CommitStepResult{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return CommitStepResult{}, fmt.Errorf("commit agent step: %w", err)
	}
	s.wakeVectors()
	return CommitStepResult{StepSeq: stepSeq, Sealed: sealed}, nil
}

func (s *Store) FailRun(
	ctx context.Context,
	runID, code, message string,
	planReply ReplyPlanner,
) error {
	_, err := s.failRun(ctx, runID, code, message, planReply, nil)
	return err
}

func (s *Store) FailRunIfInputRevision(
	ctx context.Context,
	runID, code, message string,
	planReply ReplyPlanner,
	inputRevision int64,
) (bool, error) {
	return s.failRun(ctx, runID, code, message, planReply, &inputRevision)
}

func (s *Store) failRun(
	ctx context.Context,
	runID, code, message string,
	planReply ReplyPlanner,
	expectedInputRevision *int64,
) (bool, error) {
	if planReply == nil {
		return false, errors.New("failing a run requires an outbox planner")
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin failing run: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	run, err := queries.GetRun(ctx, runID)
	if err != nil {
		return false, fmt.Errorf("load failed run: %w", err)
	}
	if run.Status != "running" {
		return false, fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	if expectedInputRevision != nil && run.InputRevision != *expectedInputRevision {
		return false, nil
	}
	now := s.now().UTC()
	updated, err := queries.SetRunTerminal(ctx, conversationdb.SetRunTerminalParams{
		Status: "failed", ErrorCode: nullableString(code), ErrorMessage: nullableString(message),
		FinishedAtMs: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: run.ID,
	})
	if err != nil {
		return false, fmt.Errorf("fail run: %w", err)
	}
	if updated != 1 {
		return false, fmt.Errorf("fail run %s: state changed", run.ID)
	}
	commitID, err := s.newID()
	if err != nil {
		return false, fmt.Errorf("generate failed run commit ID: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return false, fmt.Errorf("generate failed run record ID: %w", err)
	}
	statusPayload, err := json.Marshal(RunStatusPayload{Status: "failed", ErrorCode: code, ErrorMessage: message})
	if err != nil {
		return false, fmt.Errorf("encode failed run record: %w", err)
	}
	statusRecord, err := newRecord(recordID, commitID, RecordKindRunFailed, statusPayload, now)
	if err != nil {
		return false, err
	}
	statusRecord.ConversationID = run.ConversationID
	statusRecord.RunID = run.ID
	if _, err := appendRecord(ctx, queries, statusRecord); err != nil {
		return false, err
	}
	if err := s.enqueueReply(ctx, queries, run, commitID, now, "", "error", message, planReply); err != nil {
		return false, err
	}
	if err := transaction.Commit(); err != nil {
		return false, fmt.Errorf("commit failed run: %w", err)
	}
	return true, nil
}

func (s *Store) Recover(ctx context.Context, planReply ReplyPlanner) ([]string, error) {
	if planReply == nil {
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
		if outboxErr := s.enqueueReply(
			ctx, queries, run, commitID, now, "", "error",
			"agent process stopped before the run completed", planReply,
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
	exec sqlExecer,
	runID, conversationID, commitID string,
	now time.Time,
	inputRevision int64,
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
		if err := indexSearchMessage(ctx, exec, message.RecordID, conversationID, message.PayloadJson); err != nil {
			return nil, 0, err
		}
	}
	if err := s.appendHistoryFact(
		ctx, queries, runID, conversationID, commitID, now, first, pendingRecordIDs(pending), inputRevision,
	); err != nil {
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
		ctx, queries, run.ID, run.ConversationID, commitID, now, firstHistorySeq, historyMessageIDs, 0,
	)
}

func (s *Store) appendHistoryFact(
	ctx context.Context,
	queries *conversationdb.Queries,
	runID, conversationID, commitID string,
	now time.Time,
	firstHistorySeq int64,
	messageRecordIDs []string,
	inputRevision int64,
) error {
	recordID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate history record ID: %w", err)
	}
	payload, err := json.Marshal(HistoryAppendedPayload{
		FirstHistorySeq: firstHistorySeq, MessageRecordIDs: messageRecordIDs,
		InputRevision: inputRevision,
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
	planReply ReplyPlanner,
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
	return s.enqueueReply(
		ctx, queries, run, commitID, now, finalMessageID, "final", text, planReply,
	)
}

func (s *Store) decodeStoredMessage(_ context.Context, payload string, schemaVersion int64) (sdk.Message, error) {
	if schemaVersion != RecordSchemaVersion {
		return sdk.Message{}, fmt.Errorf("unsupported record schema version %d", schemaVersion)
	}
	var stored MessageRecordPayload
	if err := json.Unmarshal([]byte(payload), &stored); err != nil {
		return sdk.Message{}, err
	}
	return stored.Message.Decode()
}

func pendingRecordIDs(rows []conversationdb.ListPendingRunMessagesRow) []string {
	ids := make([]string, len(rows))
	for index, row := range rows {
		ids[index] = row.RecordID
	}
	return ids
}
