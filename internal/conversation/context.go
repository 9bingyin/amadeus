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
	Replies                 []ReplyChunk
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
		message, decodeErr := stored.Decode()
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
	outbox []ReplyChunk,
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
	encodedMessages, err := encodeCheckpointMessages(input.Replacement)
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
		row.ID, row.ActiveSessionID.String, commitID, now, input.Replies,
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

	encodedMessages, err := encodeCheckpointMessages(input.Replacement)
	if err != nil {
		return CommitContextCheckpointResult{}, err
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
	outbox []ReplyChunk,
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
	outbox []ReplyChunk,
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
		replyPayload, marshalErr := json.Marshal(ReplyPlannedPayload{
			OutboxID: outboxID, Kind: chunk.Kind,
			ChunkIndex: index, ChunkCount: len(outbox), Payload: chunk.Payload,
		})
		if marshalErr != nil {
			return fmt.Errorf("encode command outbox record: %w", marshalErr)
		}
		outboxRecord, recordErr := newRecord(
			outboxRecordID, commitID, RecordKindReplyPlanned, replyPayload, now,
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

func encodeCheckpointMessages(messages []sdk.Message) ([]MessageDTO, error) {
	encodedMessages := make([]MessageDTO, len(messages))
	for index, message := range messages {
		encoded, err := EncodeMessage(message)
		if err != nil {
			return nil, fmt.Errorf("encode checkpoint message %d: %w", index, err)
		}
		encodedMessages[index] = encoded.Message
	}
	return encodedMessages, nil
}
