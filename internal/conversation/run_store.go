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

type ContextSnapshot struct {
	SessionID          string
	Messages           []sdk.Message
	HistoryThroughSeq  int64
	CheckpointRecordID string
}

type CommitContextCheckpointInput struct {
	RunID                   string
	Cause                   string
	ParentRecordID          string
	SourceHistoryThroughSeq int64
	SourceInputRevision     int64
	Replacement             []sdk.Message
	SummaryModel            string
	SummaryPromptVersion    int
	SummaryUsage            *sdk.Usage
	EstimatedTokensBefore   int
	EstimatedTokensAfter    int
}

type CommitContextCheckpointResult struct {
	RecordID string
	Applied  bool
}

const (
	CommandResultNew            = "new"
	CommandResultCompacted      = "compacted"
	CommandResultMissing        = "missing"
	CommandResultNotCompactable = "not_compactable"
	CommandResultFailed         = "failed"
	CommandResultShown          = "shown"
)

type ContextCommand struct {
	Route           Route
	SourceNamespace string
	SourceEventID   string
}

type CommitManualContextCheckpointInput struct {
	ContextCommand
	ConversationID          string
	ParentRecordID          string
	SourceHistoryThroughSeq int64
	Replacement             []sdk.Message
	SummaryModel            string
	SummaryPromptVersion    int
	SummaryUsage            *sdk.Usage
	EstimatedTokensBefore   int
	EstimatedTokensAfter    int
	Outbox                  []OutboxChunk
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
	StepSeq int64
	Sealed  bool
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
		ctx, queries, run.ID, run.ConversationID, commitID, now, run.InputRevision,
	); err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("commit starting run: %w", err)
	}
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

func (s *Store) Context(ctx context.Context, conversationID string) (ContextSnapshot, error) {
	queries := conversationdb.New(s.database)
	conversation, err := queries.GetConversation(ctx, conversationID)
	if err != nil {
		return ContextSnapshot{}, fmt.Errorf("load conversation context: %w", err)
	}
	if !conversation.ActiveSessionID.Valid {
		return ContextSnapshot{}, errors.New("conversation has no active session")
	}
	snapshot := ContextSnapshot{
		SessionID:         conversation.ActiveSessionID.String,
		HistoryThroughSeq: conversation.NextHistorySeq - 1,
	}
	if !conversation.ActiveContextCheckpointRecordID.Valid {
		snapshot.Messages, err = s.History(ctx, conversationID)
		return snapshot, err
	}

	record, err := queries.GetRecord(ctx, conversation.ActiveContextCheckpointRecordID.String)
	if err != nil {
		return ContextSnapshot{}, fmt.Errorf("load context checkpoint: %w", err)
	}
	if record.Kind != string(RecordKindContextCheckpoint) || record.ConversationID.String != conversationID {
		return ContextSnapshot{}, errors.New("active context checkpoint identity does not match conversation")
	}
	if record.SchemaVersion != RecordSchemaVersion {
		return ContextSnapshot{}, fmt.Errorf("unsupported checkpoint schema version %d", record.SchemaVersion)
	}
	var payload ContextCheckpointPayload
	if err := json.Unmarshal([]byte(record.PayloadJson), &payload); err != nil {
		return ContextSnapshot{}, fmt.Errorf("decode context checkpoint: %w", err)
	}
	if payload.SessionID != "" && payload.SessionID != snapshot.SessionID {
		return ContextSnapshot{}, errors.New("active context checkpoint belongs to another session")
	}
	if payload.SourceHistoryThroughSeq > snapshot.HistoryThroughSeq ||
		(len(payload.Replacement) == 0 && payload.Cause != "new") {
		return ContextSnapshot{}, errors.New("active context checkpoint is invalid")
	}
	snapshot.CheckpointRecordID = record.ID
	snapshot.Messages = make([]sdk.Message, 0, len(payload.Replacement))
	for index, stored := range payload.Replacement {
		message, decodeErr := stored.Decode(ctx, func(ctx context.Context, digest BlobDigest) ([]byte, error) {
			return s.LoadBlob(ctx, digest)
		})
		if decodeErr != nil {
			return ContextSnapshot{}, fmt.Errorf("decode checkpoint message %d: %w", index, decodeErr)
		}
		snapshot.Messages = append(snapshot.Messages, message)
	}
	rows, err := queries.ListConversationHistoryAfter(ctx, conversationdb.ListConversationHistoryAfterParams{
		ConversationID: conversationID,
		HistorySeq:     sql.NullInt64{Int64: payload.SourceHistoryThroughSeq, Valid: true},
	})
	if err != nil {
		return ContextSnapshot{}, fmt.Errorf("list context history suffix: %w", err)
	}
	for _, row := range rows {
		message, decodeErr := s.decodeStoredMessage(ctx, row.PayloadJson, row.SchemaVersion)
		if decodeErr != nil {
			return ContextSnapshot{}, fmt.Errorf("decode context history message %s: %w", row.RecordID, decodeErr)
		}
		snapshot.Messages = append(snapshot.Messages, message)
	}
	return snapshot, nil
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
		ctx, queries, run.ID, run.ConversationID, commitID, now, run.InputRevision,
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

func (s *Store) ContextByRoute(ctx context.Context, route Route) (string, ContextSnapshot, error) {
	if err := normalizeRoute(&route); err != nil {
		return "", ContextSnapshot{}, err
	}
	row, err := conversationdb.New(s.database).GetConversationByRoute(ctx, conversationdb.GetConversationByRouteParams{
		Platform: route.Platform, AccountID: route.AccountID,
		ExternalChatID: route.ChatID, ExternalThreadID: route.ThreadID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", ContextSnapshot{}, ErrConversationMissing
	}
	if err != nil {
		return "", ContextSnapshot{}, fmt.Errorf("load conversation by route: %w", err)
	}
	snapshot, err := s.Context(ctx, row.ID)
	return row.ID, snapshot, err
}

func (s *Store) ContextCommandResult(
	ctx context.Context,
	command ContextCommand,
) (string, bool, error) {
	if err := normalizeContextCommand(&command); err != nil {
		return "", false, err
	}
	return contextCommandResult(ctx, conversationdb.New(s.database), command)
}

func (s *Store) ResetContext(
	ctx context.Context,
	command ContextCommand,
	outbox []OutboxChunk,
) (bool, error) {
	if err := normalizeContextCommand(&command); err != nil {
		return false, err
	}
	commitID, recordID, err := s.newCheckpointIDs()
	if err != nil {
		return false, err
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin resetting context: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	if _, duplicate, duplicateErr := contextCommandResult(ctx, queries, command); duplicateErr != nil {
		return false, duplicateErr
	} else if duplicate {
		return false, nil
	}
	now := s.now().UTC()
	row, err := queries.GetConversationByRoute(ctx, conversationdb.GetConversationByRouteParams{
		Platform: command.Route.Platform, AccountID: command.Route.AccountID,
		ExternalChatID: command.Route.ChatID, ExternalThreadID: command.Route.ThreadID,
	})
	createdConversation := false
	if errors.Is(err, sql.ErrNoRows) {
		conversationID, idErr := s.newID()
		if idErr != nil {
			return false, fmt.Errorf("generate conversation ID: %w", idErr)
		}
		createdRecordID, idErr := s.newID()
		if idErr != nil {
			return false, fmt.Errorf("generate conversation record ID: %w", idErr)
		}
		row, err = queries.UpsertConversation(ctx, conversationdb.UpsertConversationParams{
			ID: conversationID, Platform: command.Route.Platform, AccountID: command.Route.AccountID,
			ExternalChatID: command.Route.ChatID, ExternalThreadID: command.Route.ThreadID,
			CreatedAtMs: now.UnixMilli(), UpdatedAtMs: now.UnixMilli(),
		})
		if err != nil {
			return false, fmt.Errorf("create conversation for context reset: %w", err)
		}
		payload, marshalErr := json.Marshal(ConversationCreatedPayload{
			Platform: command.Route.Platform, AccountID: command.Route.AccountID,
			ExternalChatID: command.Route.ChatID, ExternalThreadID: command.Route.ThreadID,
		})
		if marshalErr != nil {
			return false, fmt.Errorf("encode reset conversation record: %w", marshalErr)
		}
		created, recordErr := newRecord(
			createdRecordID, commitID, RecordKindConversationCreated, payload, now,
		)
		if recordErr != nil {
			return false, recordErr
		}
		created.ConversationID = row.ID
		if _, appendErr := appendRecord(ctx, queries, created); appendErr != nil {
			return false, appendErr
		}
		if sessionErr := createInitialSession(ctx, queries, row.ID, createdRecordID, now); sessionErr != nil {
			return false, sessionErr
		}
		row.ActiveSessionID = sql.NullString{String: row.ID, Valid: true}
		createdConversation = true
	} else if err != nil {
		return false, fmt.Errorf("load conversation to reset: %w", err)
	}
	if _, openErr := queries.GetOpenRun(ctx, row.ID); openErr == nil {
		return false, ErrConversationBusy
	} else if !errors.Is(openErr, sql.ErrNoRows) {
		return false, fmt.Errorf("check conversation before reset: %w", openErr)
	}
	if !row.ActiveSessionID.Valid {
		return false, errors.New("conversation has no active session")
	}
	sessionID := row.ActiveSessionID.String
	if !createdConversation {
		nextSessionID, idErr := s.newID()
		if idErr != nil {
			return false, fmt.Errorf("generate session ID: %w", idErr)
		}
		sessionRecordID, idErr := s.newID()
		if idErr != nil {
			return false, fmt.Errorf("generate session record ID: %w", idErr)
		}
		sessionPayload, marshalErr := json.Marshal(SessionStartedPayload{
			SessionID: nextSessionID, PreviousSessionID: sessionID,
			StartHistorySeq: row.NextHistorySeq, Cause: "new",
		})
		if marshalErr != nil {
			return false, fmt.Errorf("encode session start record: %w", marshalErr)
		}
		sessionRecord, recordErr := newRecord(
			sessionRecordID, commitID, RecordKindSessionStarted, sessionPayload, now,
		)
		if recordErr != nil {
			return false, recordErr
		}
		sessionRecord.ConversationID = row.ID
		if _, appendErr := appendRecord(ctx, queries, sessionRecord); appendErr != nil {
			return false, appendErr
		}
		if switchErr := switchSession(
			ctx, queries, row.ID, sessionID, nextSessionID, sessionRecordID,
			row.NextHistorySeq, now,
		); switchErr != nil {
			return false, switchErr
		}
		sessionID = nextSessionID
	}
	payload, err := json.Marshal(ContextCheckpointPayload{
		SessionID: sessionID,
		Cause:     "new", ParentRecordID: row.ActiveContextCheckpointRecordID.String,
		SourceHistoryThroughSeq: row.NextHistorySeq - 1,
		Replacement:             []MessageDTO{},
	})
	if err != nil {
		return false, fmt.Errorf("encode context reset record: %w", err)
	}
	record, err := newRecord(recordID, commitID, RecordKindContextCheckpoint, payload, now)
	if err != nil {
		return false, err
	}
	record.ConversationID = row.ID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return false, err
	}
	updated, err := queries.SetActiveContextCheckpoint(ctx, conversationdb.SetActiveContextCheckpointParams{
		RecordID: sql.NullString{String: recordID, Valid: true}, UpdatedAtMs: now.UnixMilli(),
		ConversationID: row.ID, HistoryThroughSeq: row.NextHistorySeq - 1,
		ParentRecordID: sql.NullString{String: row.ActiveContextCheckpointRecordID.String, Valid: true},
	})
	if err != nil {
		return false, fmt.Errorf("activate context reset: %w", err)
	}
	if updated != 1 {
		return false, errors.New("activate context reset: state changed")
	}
	if err := s.appendCommandCompletion(
		ctx, queries, command, "new", CommandResultNew, row.ID, sessionID,
		commitID, now, outbox,
	); err != nil {
		return false, err
	}
	if err := transaction.Commit(); err != nil {
		return false, fmt.Errorf("commit context reset: %w", err)
	}
	return true, nil
}

func (s *Store) CommitManualContextCheckpoint(
	ctx context.Context,
	input CommitManualContextCheckpointInput,
) (CommitContextCheckpointResult, error) {
	if err := normalizeContextCommand(&input.ContextCommand); err != nil {
		return CommitContextCheckpointResult{}, err
	}
	if input.ConversationID == "" || input.SourceHistoryThroughSeq < 1 || len(input.Replacement) == 0 {
		return CommitContextCheckpointResult{}, errors.New("manual context checkpoint source is invalid")
	}
	if strings.TrimSpace(input.SummaryModel) == "" || input.SummaryPromptVersion < 1 {
		return CommitContextCheckpointResult{}, errors.New("manual context checkpoint summary identity is invalid")
	}
	if input.EstimatedTokensAfter < 0 || input.EstimatedTokensAfter >= input.EstimatedTokensBefore {
		return CommitContextCheckpointResult{}, errors.New("manual context checkpoint does not reduce estimated tokens")
	}
	encodedMessages, checkpointBlobs, err := encodeCheckpointMessages(input.Replacement)
	if err != nil {
		return CommitContextCheckpointResult{}, err
	}
	commitID, recordID, err := s.newCheckpointIDs()
	if err != nil {
		return CommitContextCheckpointResult{}, err
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("begin committing manual context checkpoint: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	if _, duplicate, duplicateErr := contextCommandResult(ctx, queries, input.ContextCommand); duplicateErr != nil {
		return CommitContextCheckpointResult{}, duplicateErr
	} else if duplicate {
		return CommitContextCheckpointResult{Applied: true}, nil
	}
	row, err := queries.GetConversation(ctx, input.ConversationID)
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("load manually compacted conversation: %w", err)
	}
	if row.Platform != input.Route.Platform || row.AccountID != input.Route.AccountID ||
		row.ExternalChatID != input.Route.ChatID || row.ExternalThreadID != input.Route.ThreadID {
		return CommitContextCheckpointResult{}, errors.New("manual context checkpoint route does not match conversation")
	}
	if _, openErr := queries.GetOpenRun(ctx, row.ID); openErr == nil {
		return CommitContextCheckpointResult{}, ErrConversationBusy
	} else if !errors.Is(openErr, sql.ErrNoRows) {
		return CommitContextCheckpointResult{}, fmt.Errorf("check conversation before manual checkpoint: %w", openErr)
	}
	if !row.ActiveSessionID.Valid {
		return CommitContextCheckpointResult{}, errors.New("conversation has no active session")
	}
	if row.NextHistorySeq-1 != input.SourceHistoryThroughSeq ||
		row.ActiveContextCheckpointRecordID.String != input.ParentRecordID {
		return CommitContextCheckpointResult{Applied: false}, nil
	}
	var summaryUsage *UsageDTO
	if input.SummaryUsage != nil {
		usage := usageFromSDK(*input.SummaryUsage)
		summaryUsage = &usage
	}
	payload, err := json.Marshal(ContextCheckpointPayload{
		SessionID: row.ActiveSessionID.String,
		Cause:     "manual", ParentRecordID: input.ParentRecordID,
		SourceHistoryThroughSeq: input.SourceHistoryThroughSeq,
		Replacement:             encodedMessages, SummaryModel: input.SummaryModel,
		SummaryPromptVersion: input.SummaryPromptVersion, SummaryUsage: summaryUsage,
		EstimatedTokensBefore: input.EstimatedTokensBefore,
		EstimatedTokensAfter:  input.EstimatedTokensAfter,
	})
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("encode manual context checkpoint record: %w", err)
	}
	now := s.now().UTC()
	record, err := newRecord(recordID, commitID, RecordKindContextCheckpoint, payload, now)
	if err != nil {
		return CommitContextCheckpointResult{}, err
	}
	record.ConversationID = row.ID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return CommitContextCheckpointResult{}, err
	}
	if err := insertBlobs(ctx, queries, recordID, checkpointBlobs, now.UnixMilli()); err != nil {
		return CommitContextCheckpointResult{}, err
	}
	updated, err := queries.SetActiveContextCheckpoint(ctx, conversationdb.SetActiveContextCheckpointParams{
		RecordID: sql.NullString{String: recordID, Valid: true}, UpdatedAtMs: now.UnixMilli(),
		ConversationID: row.ID, HistoryThroughSeq: input.SourceHistoryThroughSeq,
		ParentRecordID: sql.NullString{String: input.ParentRecordID, Valid: true},
	})
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("activate manual context checkpoint: %w", err)
	}
	if updated != 1 {
		return CommitContextCheckpointResult{}, errors.New("activate manual context checkpoint: state changed")
	}
	if err := s.appendCommandCompletion(
		ctx, queries, input.ContextCommand, "compact", CommandResultCompacted,
		row.ID, row.ActiveSessionID.String, commitID, now, input.Outbox,
	); err != nil {
		return CommitContextCheckpointResult{}, err
	}
	if err := transaction.Commit(); err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("commit manual context checkpoint: %w", err)
	}
	return CommitContextCheckpointResult{RecordID: recordID, Applied: true}, nil
}

func (s *Store) CommitContextCheckpoint(
	ctx context.Context,
	input CommitContextCheckpointInput,
) (CommitContextCheckpointResult, error) {
	if input.RunID == "" {
		return CommitContextCheckpointResult{}, errors.New("run ID is required")
	}
	if input.Cause != "threshold" && input.Cause != "overflow" {
		return CommitContextCheckpointResult{}, fmt.Errorf("context checkpoint cause %q is invalid", input.Cause)
	}
	if input.SourceHistoryThroughSeq < 1 || input.SourceInputRevision < 1 {
		return CommitContextCheckpointResult{}, errors.New("context checkpoint source is invalid")
	}
	if len(input.Replacement) == 0 {
		return CommitContextCheckpointResult{}, errors.New("context checkpoint replacement is empty")
	}
	if strings.TrimSpace(input.SummaryModel) == "" || input.SummaryPromptVersion < 1 {
		return CommitContextCheckpointResult{}, errors.New("context checkpoint summary identity is invalid")
	}
	if input.EstimatedTokensAfter < 0 || input.EstimatedTokensAfter >= input.EstimatedTokensBefore {
		return CommitContextCheckpointResult{}, errors.New("context checkpoint does not reduce estimated tokens")
	}

	encodedMessages := make([]MessageDTO, len(input.Replacement))
	checkpointBlobs := make([]EncodedBlob, 0)
	blobIndex := 0
	for index, message := range input.Replacement {
		encoded, err := EncodeMessage(message)
		if err != nil {
			return CommitContextCheckpointResult{}, fmt.Errorf("encode checkpoint message %d: %w", index, err)
		}
		encodedMessages[index] = encoded.Message
		for _, blob := range encoded.Blobs {
			checkpointBlobs = append(checkpointBlobs, EncodedBlob{PartIndex: blobIndex, Blob: blob.Blob})
			blobIndex++
		}
	}

	commitID, err := s.newID()
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("generate checkpoint commit ID: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("generate checkpoint record ID: %w", err)
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("begin committing context checkpoint: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	run, err := queries.GetRun(ctx, input.RunID)
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("load checkpoint run: %w", err)
	}
	if run.Status != "running" {
		return CommitContextCheckpointResult{}, fmt.Errorf("%w: %s", ErrRunNotRunning, run.Status)
	}
	if run.InputRevision != input.SourceInputRevision ||
		run.HandledInputRevision != input.SourceInputRevision || run.InputNotBeforeMs.Valid {
		return CommitContextCheckpointResult{Applied: false}, nil
	}
	conversation, err := queries.GetConversation(ctx, run.ConversationID)
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("load checkpoint conversation: %w", err)
	}
	if !run.SessionID.Valid || !conversation.ActiveSessionID.Valid ||
		run.SessionID.String != conversation.ActiveSessionID.String {
		return CommitContextCheckpointResult{}, errors.New("checkpoint run does not belong to active session")
	}
	if conversation.NextHistorySeq-1 != input.SourceHistoryThroughSeq ||
		conversation.ActiveContextCheckpointRecordID.String != input.ParentRecordID {
		return CommitContextCheckpointResult{Applied: false}, nil
	}

	var summaryUsage *UsageDTO
	if input.SummaryUsage != nil {
		usage := usageFromSDK(*input.SummaryUsage)
		summaryUsage = &usage
	}
	payload, err := json.Marshal(ContextCheckpointPayload{
		SessionID: run.SessionID.String,
		Cause:     input.Cause, ParentRecordID: input.ParentRecordID,
		SourceHistoryThroughSeq: input.SourceHistoryThroughSeq,
		SourceInputRevision:     input.SourceInputRevision,
		Replacement:             encodedMessages, SummaryModel: input.SummaryModel,
		SummaryPromptVersion: input.SummaryPromptVersion, SummaryUsage: summaryUsage,
		EstimatedTokensBefore: input.EstimatedTokensBefore,
		EstimatedTokensAfter:  input.EstimatedTokensAfter,
	})
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("encode context checkpoint record: %w", err)
	}
	now := s.now().UTC()
	record, err := newRecord(recordID, commitID, RecordKindContextCheckpoint, payload, now)
	if err != nil {
		return CommitContextCheckpointResult{}, err
	}
	record.ConversationID = run.ConversationID
	record.RunID = run.ID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return CommitContextCheckpointResult{}, err
	}
	if err := insertBlobs(ctx, queries, recordID, checkpointBlobs, now.UnixMilli()); err != nil {
		return CommitContextCheckpointResult{}, err
	}
	updated, err := queries.SetActiveContextCheckpoint(ctx, conversationdb.SetActiveContextCheckpointParams{
		RecordID:    sql.NullString{String: recordID, Valid: true},
		UpdatedAtMs: now.UnixMilli(), ConversationID: run.ConversationID,
		HistoryThroughSeq: input.SourceHistoryThroughSeq,
		ParentRecordID:    sql.NullString{String: input.ParentRecordID, Valid: true},
	})
	if err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("activate context checkpoint: %w", err)
	}
	if updated != 1 {
		return CommitContextCheckpointResult{}, errors.New("activate context checkpoint: state changed")
	}
	if err := transaction.Commit(); err != nil {
		return CommitContextCheckpointResult{}, fmt.Errorf("commit context checkpoint: %w", err)
	}
	return CommitContextCheckpointResult{RecordID: recordID, Applied: true}, nil
}

func (s *Store) CompleteContextCommand(
	ctx context.Context,
	command ContextCommand,
	name, result, conversationID string,
	outbox []OutboxChunk,
) error {
	if err := normalizeContextCommand(&command); err != nil {
		return err
	}
	if strings.TrimSpace(name) == "" || strings.TrimSpace(result) == "" {
		return errors.New("conversation command result is incomplete")
	}
	commitID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate conversation command commit ID: %w", err)
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin completing conversation command: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	if _, duplicate, duplicateErr := contextCommandResult(ctx, queries, command); duplicateErr != nil {
		return duplicateErr
	} else if duplicate {
		return nil
	}
	now := s.now().UTC()
	if conversationID == "" && len(outbox) > 0 {
		generatedID, idErr := s.newID()
		if idErr != nil {
			return fmt.Errorf("generate command conversation ID: %w", idErr)
		}
		createdRecordID, idErr := s.newID()
		if idErr != nil {
			return fmt.Errorf("generate command conversation record ID: %w", idErr)
		}
		row, createErr := queries.UpsertConversation(ctx, conversationdb.UpsertConversationParams{
			ID: generatedID, Platform: command.Route.Platform, AccountID: command.Route.AccountID,
			ExternalChatID: command.Route.ChatID, ExternalThreadID: command.Route.ThreadID,
			CreatedAtMs: now.UnixMilli(), UpdatedAtMs: now.UnixMilli(),
		})
		if createErr != nil {
			return fmt.Errorf("create conversation for command result: %w", createErr)
		}
		conversationID = row.ID
		if row.ID == generatedID {
			payload, marshalErr := json.Marshal(ConversationCreatedPayload{
				Platform: command.Route.Platform, AccountID: command.Route.AccountID,
				ExternalChatID: command.Route.ChatID, ExternalThreadID: command.Route.ThreadID,
			})
			if marshalErr != nil {
				return fmt.Errorf("encode command conversation record: %w", marshalErr)
			}
			created, recordErr := newRecord(
				createdRecordID, commitID, RecordKindConversationCreated, payload, now,
			)
			if recordErr != nil {
				return recordErr
			}
			created.ConversationID = conversationID
			if _, appendErr := appendRecord(ctx, queries, created); appendErr != nil {
				return appendErr
			}
			if sessionErr := createInitialSession(
				ctx, queries, conversationID, createdRecordID, now,
			); sessionErr != nil {
				return sessionErr
			}
		}
	}
	sessionID := ""
	if conversationID != "" {
		row, loadErr := queries.GetConversation(ctx, conversationID)
		if loadErr != nil {
			return fmt.Errorf("load conversation command target: %w", loadErr)
		}
		if row.Platform != command.Route.Platform || row.AccountID != command.Route.AccountID ||
			row.ExternalChatID != command.Route.ChatID || row.ExternalThreadID != command.Route.ThreadID {
			return errors.New("conversation command route does not match conversation")
		}
		if !row.ActiveSessionID.Valid {
			return errors.New("conversation has no active session")
		}
		sessionID = row.ActiveSessionID.String
	}
	if err := s.appendCommandCompletion(
		ctx, queries, command, name, result, conversationID, sessionID,
		commitID, now, outbox,
	); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit conversation command result: %w", err)
	}
	return nil
}

func normalizeRoute(route *Route) error {
	route.Platform = strings.TrimSpace(route.Platform)
	route.AccountID = strings.TrimSpace(route.AccountID)
	route.ChatID = strings.TrimSpace(route.ChatID)
	route.ThreadID = strings.TrimSpace(route.ThreadID)
	if route.Platform == "" || route.AccountID == "" || route.ChatID == "" {
		return errors.New("conversation route is incomplete")
	}
	return nil
}

func normalizeContextCommand(command *ContextCommand) error {
	if err := normalizeRoute(&command.Route); err != nil {
		return err
	}
	command.SourceNamespace = strings.TrimSpace(command.SourceNamespace)
	command.SourceEventID = strings.TrimSpace(command.SourceEventID)
	if command.SourceNamespace == "" || command.SourceEventID == "" {
		return errors.New("context command source identity is incomplete")
	}
	return nil
}

func contextCommandResult(
	ctx context.Context,
	queries *conversationdb.Queries,
	command ContextCommand,
) (string, bool, error) {
	record, err := queries.GetContextCommandRecord(ctx, conversationdb.GetContextCommandRecordParams{
		SourceNamespace: sql.NullString{String: command.SourceNamespace, Valid: true},
		SourceEventID:   sql.NullString{String: command.SourceEventID, Valid: true},
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("look up context command: %w", err)
	}
	var payload CommandCompletedPayload
	if err := json.Unmarshal([]byte(record.PayloadJson), &payload); err != nil {
		return "", false, fmt.Errorf("decode conversation command result: %w", err)
	}
	if strings.TrimSpace(payload.Command) == "" || strings.TrimSpace(payload.Result) == "" {
		return "", false, errors.New("conversation command result is invalid")
	}
	return payload.Result, true, nil
}

func (s *Store) appendCommandCompletion(
	ctx context.Context,
	queries *conversationdb.Queries,
	command ContextCommand,
	name, result, conversationID, sessionID, commitID string,
	now time.Time,
	outbox []OutboxChunk,
) error {
	payload, err := json.Marshal(CommandCompletedPayload{
		Command: name, Result: result, SessionID: sessionID,
	})
	if err != nil {
		return fmt.Errorf("encode conversation command result: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return fmt.Errorf("generate conversation command record ID: %w", err)
	}
	record, err := newRecord(recordID, commitID, RecordKindCommandCompleted, payload, now)
	if err != nil {
		return err
	}
	record.ConversationID = conversationID
	record.SourceNamespace = command.SourceNamespace
	record.SourceEventID = command.SourceEventID
	if _, err := appendRecord(ctx, queries, record); err != nil {
		return err
	}
	for index, chunk := range outbox {
		if chunk.Kind != "command" || !json.Valid(chunk.Payload) {
			return fmt.Errorf("command outbox chunk %d is invalid", index)
		}
		outboxID, idErr := s.newID()
		if idErr != nil {
			return fmt.Errorf("generate command outbox ID: %w", idErr)
		}
		outboxRecordID, idErr := s.newID()
		if idErr != nil {
			return fmt.Errorf("generate command outbox record ID: %w", idErr)
		}
		outboxPayload, marshalErr := json.Marshal(OutboxPlannedPayload{
			OutboxID: outboxID, Kind: chunk.Kind,
			ChunkIndex: index, ChunkCount: len(outbox), Payload: chunk.Payload,
		})
		if marshalErr != nil {
			return fmt.Errorf("encode command outbox record: %w", marshalErr)
		}
		outboxRecord, recordErr := newRecord(
			outboxRecordID, commitID, RecordKindOutboxPlanned, outboxPayload, now,
		)
		if recordErr != nil {
			return recordErr
		}
		outboxRecord.ConversationID = conversationID
		enqueueSeq, appendErr := appendRecord(ctx, queries, outboxRecord)
		if appendErr != nil {
			return appendErr
		}
		if insertErr := queries.InsertOutbox(ctx, conversationdb.InsertOutboxParams{
			ID: outboxID, RecordID: outboxRecordID, EnqueueSeq: enqueueSeq,
			ConversationID: conversationID, RunID: sql.NullString{},
			MessageRecordID: sql.NullString{}, ReplyToRecordID: sql.NullString{},
			Kind: chunk.Kind, ChunkIndex: int64(index), ChunkCount: int64(len(outbox)),
			AvailableAtMs: now.UnixMilli(), CreatedAtMs: now.UnixMilli(),
		}); insertErr != nil {
			return fmt.Errorf("insert command outbox chunk %d: %w", index, insertErr)
		}
	}
	return nil
}

func (s *Store) newCheckpointIDs() (string, string, error) {
	commitID, err := s.newID()
	if err != nil {
		return "", "", fmt.Errorf("generate checkpoint commit ID: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return "", "", fmt.Errorf("generate checkpoint record ID: %w", err)
	}
	return commitID, recordID, nil
}

func encodeCheckpointMessages(messages []sdk.Message) ([]MessageDTO, []EncodedBlob, error) {
	encodedMessages := make([]MessageDTO, len(messages))
	checkpointBlobs := make([]EncodedBlob, 0)
	blobIndex := 0
	for index, message := range messages {
		encoded, err := EncodeMessage(message)
		if err != nil {
			return nil, nil, fmt.Errorf("encode checkpoint message %d: %w", index, err)
		}
		encodedMessages[index] = encoded.Message
		for _, blob := range encoded.Blobs {
			checkpointBlobs = append(checkpointBlobs, EncodedBlob{PartIndex: blobIndex, Blob: blob.Blob})
			blobIndex++
		}
	}
	return encodedMessages, checkpointBlobs, nil
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
	if err := s.appendStepFacts(
		ctx, queries, run, commitID, now, stepSeq,
		messageRecordIDs, messageRecordIDs, firstHistorySeq, input.Final,
	); err != nil {
		return CommitStepResult{}, err
	}

	sealed := input.Final && run.InputRevision == run.HandledInputRevision && !run.InputNotBeforeMs.Valid
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
	return CommitStepResult{StepSeq: stepSeq, Sealed: sealed}, nil
}

func (s *Store) FailRun(
	ctx context.Context,
	runID, code, message string,
	planOutbox OutboxPlanner,
) error {
	_, err := s.failRun(ctx, runID, code, message, planOutbox, nil)
	return err
}

func (s *Store) FailRunIfInputRevision(
	ctx context.Context,
	runID, code, message string,
	planOutbox OutboxPlanner,
	inputRevision int64,
) (bool, error) {
	return s.failRun(ctx, runID, code, message, planOutbox, &inputRevision)
}

func (s *Store) failRun(
	ctx context.Context,
	runID, code, message string,
	planOutbox OutboxPlanner,
	expectedInputRevision *int64,
) (bool, error) {
	if planOutbox == nil {
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
	if err := s.enqueueOutbox(ctx, queries, run, commitID, now, "", "error", message, planOutbox); err != nil {
		return false, err
	}
	if err := transaction.Commit(); err != nil {
		return false, fmt.Errorf("commit failed run: %w", err)
	}
	return true, nil
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
			ID: row.ID, ConversationID: row.ConversationID, RunID: row.RunID.String,
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
			ConversationID: run.ConversationID, RunID: nullableString(run.ID),
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
	record.RunID = row.RunID.String
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
