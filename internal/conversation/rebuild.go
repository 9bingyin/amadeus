package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/9bingyin/amadeus/internal/conversation/db"
)

type historyAssignment struct {
	sequence    int64
	committedAt int64
}

// RebuildProjections deterministically recreates all mutable online tables
// from the immutable record journal. It never invokes a provider, tool, or
// message platform.
func (s *Store) RebuildProjections(ctx context.Context) error {
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin projection rebuild: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	rows, err := queries.ListRecords(ctx)
	if err != nil {
		return fmt.Errorf("load records for projection rebuild: %w", err)
	}
	records := make([]Record, len(rows))
	for index, row := range rows {
		record, convertErr := recordFromDatabase(row)
		if convertErr != nil {
			return fmt.Errorf("validate record %d for projection rebuild: %w", index, convertErr)
		}
		records[index] = record
	}
	assignments, nextHistory, err := collectHistoryAssignments(records)
	if err != nil {
		return err
	}
	for _, statement := range []string{
		"DELETE FROM outbox",
		"DELETE FROM messages",
		"DELETE FROM runs",
		"UPDATE conversations SET active_session_id = NULL",
		"DELETE FROM sessions",
		"DELETE FROM conversations",
	} {
		if _, err := transaction.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("reset projections: %w", err)
		}
	}
	replayHistory := make(map[string]int64)
	for _, record := range records {
		if err := reduceRecord(ctx, transaction, queries, record, assignments, replayHistory); err != nil {
			return fmt.Errorf("reduce record %d (%s): %w", record.Seq, record.Kind, err)
		}
	}
	for conversationID, next := range nextHistory {
		if _, err := transaction.ExecContext(
			ctx,
			"UPDATE conversations SET next_history_seq = ? WHERE id = ?",
			next,
			conversationID,
		); err != nil {
			return fmt.Errorf("restore next history sequence for %s: %w", conversationID, err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit projection rebuild: %w", err)
	}
	return nil
}

func collectHistoryAssignments(
	records []Record,
) (map[string]historyAssignment, map[string]int64, error) {
	assignments := make(map[string]historyAssignment)
	nextHistory := make(map[string]int64)
	for _, record := range records {
		if record.Kind != RecordKindHistoryAppended {
			continue
		}
		var payload HistoryAppendedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return nil, nil, fmt.Errorf("decode history record %s: %w", record.ID, err)
		}
		if payload.FirstHistorySeq < 1 || len(payload.MessageRecordIDs) == 0 {
			return nil, nil, fmt.Errorf("history record %s has invalid range", record.ID)
		}
		for index, messageID := range payload.MessageRecordIDs {
			if _, exists := assignments[messageID]; exists {
				return nil, nil, fmt.Errorf("message %s has multiple history assignments", messageID)
			}
			sequence := payload.FirstHistorySeq + int64(index)
			assignments[messageID] = historyAssignment{
				sequence: sequence, committedAt: record.CreatedAt.UnixMilli(),
			}
			if sequence >= nextHistory[record.ConversationID] {
				nextHistory[record.ConversationID] = sequence + 1
			}
		}
	}
	return assignments, nextHistory, nil
}

func reduceRecord(
	ctx context.Context,
	transaction *sql.Tx,
	queries *conversationdb.Queries,
	record Record,
	assignments map[string]historyAssignment,
	replayHistory map[string]int64,
) error {
	switch record.Kind {
	case RecordKindConversationCreated:
		var payload ConversationCreatedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		conversation, err := queries.UpsertConversation(ctx, conversationdb.UpsertConversationParams{
			ID: record.ConversationID, Platform: payload.Platform, AccountID: payload.AccountID,
			ExternalChatID: payload.ExternalChatID, ExternalThreadID: payload.ExternalThreadID,
			CreatedAtMs: record.CreatedAt.UnixMilli(), UpdatedAtMs: record.CreatedAt.UnixMilli(),
		})
		if err != nil {
			return err
		}
		return createInitialSession(
			ctx, queries, conversation.ID, record.ID, record.CreatedAt,
		)
	case RecordKindSessionStarted:
		var payload SessionStartedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		if payload.SessionID == "" || payload.PreviousSessionID == "" ||
			payload.Cause != "new" || payload.StartHistorySeq < 1 {
			return errors.New("session start payload is invalid")
		}
		if payload.StartHistorySeq != replayHistory[record.ConversationID]+1 {
			return errors.New("session start history boundary does not match replay history")
		}
		return switchSession(
			ctx, queries, record.ConversationID, payload.PreviousSessionID,
			payload.SessionID, record.ID, payload.StartHistorySeq, record.CreatedAt,
		)
	case RecordKindRunCreated:
		var payload RunCreatedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		inputNotBeforeMS := payload.InputNotBeforeMS
		if inputNotBeforeMS == 0 {
			inputNotBeforeMS = record.CreatedAt.UnixMilli()
		}
		sessionID := payload.SessionID
		conversation, err := queries.GetConversation(ctx, record.ConversationID)
		if err != nil {
			return err
		}
		if sessionID == "" {
			sessionID = conversation.ActiveSessionID.String
		}
		if sessionID == "" || !conversation.ActiveSessionID.Valid ||
			sessionID != conversation.ActiveSessionID.String {
			return errors.New("run session does not match active session")
		}
		return queries.InsertRun(ctx, conversationdb.InsertRunParams{
			ID: record.RunID, ConversationID: record.ConversationID,
			SessionID: sql.NullString{String: sessionID, Valid: true}, QueueSeq: record.Seq,
			Provider: payload.Provider, Model: payload.Model,
			ReasoningEffort: nullableString(payload.ReasoningEffort), SystemPrompt: payload.SystemPrompt,
			ConfigJson: nullableJSON(payload.Config), CreatedAtMs: record.CreatedAt.UnixMilli(),
			InputNotBeforeMs: sql.NullInt64{Int64: inputNotBeforeMS, Valid: true},
		})
	case RecordKindMessageCreated:
		var payload MessageRecordPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		assignment, committed := assignments[record.ID]
		params := conversationdb.InsertMessageParams{
			RecordID: record.ID, ConversationID: record.ConversationID, RunID: record.RunID,
			SourceRecordID: nullableString(payload.SourceRecordID), Role: payload.Message.Role,
		}
		if payload.StepSeq != nil {
			params.StepSeq = sql.NullInt64{Int64: *payload.StepSeq, Valid: true}
		}
		if payload.StepMessageSeq != nil {
			params.StepMessageSeq = sql.NullInt64{Int64: *payload.StepMessageSeq, Valid: true}
		}
		if committed {
			params.HistorySeq = sql.NullInt64{Int64: assignment.sequence, Valid: true}
			params.CommittedAtMs = sql.NullInt64{Int64: assignment.committedAt, Valid: true}
		}
		if err := queries.InsertMessage(ctx, params); err != nil {
			return err
		}
		if payload.Message.Role == "user" {
			handledIncrement := 0
			if committed {
				handledIncrement = 1
			}
			_, err := transaction.ExecContext(
				ctx,
				`UPDATE runs
SET input_revision = input_revision + 1,
    handled_input_revision = handled_input_revision + ?
WHERE id = ?`,
				handledIncrement, record.RunID,
			)
			return err
		}
		return nil
	case RecordKindRunStarted:
		_, err := transaction.ExecContext(
			ctx,
			`UPDATE runs
SET status = 'running', started_at_ms = ?, handled_input_revision = input_revision,
    input_not_before_ms = NULL
WHERE id = ?`,
			record.CreatedAt.UnixMilli(), record.RunID,
		)
		return err
	case RecordKindRunCompleted:
		return restoreRunTerminal(ctx, transaction, record, "completed", "", "")
	case RecordKindRunFailed:
		var payload RunStatusPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		return restoreRunTerminal(ctx, transaction, record, "failed", payload.ErrorCode, payload.ErrorMessage)
	case RecordKindRunInterrupted:
		var payload RunStatusPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		return restoreRunTerminal(ctx, transaction, record, "interrupted", payload.ErrorCode, payload.ErrorMessage)
	case RecordKindOutboxPlanned:
		var payload OutboxPlannedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		return queries.InsertOutbox(ctx, conversationdb.InsertOutboxParams{
			ID: payload.OutboxID, RecordID: record.ID, EnqueueSeq: record.Seq,
			ConversationID: record.ConversationID, RunID: nullableString(record.RunID),
			MessageRecordID: nullableString(payload.MessageRecordID),
			ReplyToRecordID: nullableString(payload.ReplyToRecordID), Kind: payload.Kind,
			ChunkIndex: int64(payload.ChunkIndex), ChunkCount: int64(payload.ChunkCount),
			AvailableAtMs: record.CreatedAt.UnixMilli(), CreatedAtMs: record.CreatedAt.UnixMilli(),
		})
	case RecordKindDeliveryStarted:
		var payload DeliveryPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		_, err := transaction.ExecContext(
			ctx,
			"UPDATE outbox SET attempts = ? WHERE id = ? AND status = 'pending'",
			payload.Attempt, payload.OutboxID,
		)
		return err
	case RecordKindDeliverySent:
		var payload DeliveryPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		_, err := transaction.ExecContext(
			ctx,
			"UPDATE outbox SET status = 'sent', sent_at_ms = ?, last_error = NULL WHERE id = ?",
			record.CreatedAt.UnixMilli(), payload.OutboxID,
		)
		return err
	case RecordKindStepCommitted:
		var payload StepCommittedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		_, err := transaction.ExecContext(
			ctx,
			"UPDATE runs SET next_step_seq = MAX(next_step_seq, ?) WHERE id = ?",
			payload.StepSeq+1, record.RunID,
		)
		return err
	case RecordKindDeliveryFailed:
		var payload DeliveryPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		status := "pending"
		if payload.Dead {
			status = "dead"
		}
		_, err := transaction.ExecContext(
			ctx,
			"UPDATE outbox SET status = ?, available_at_ms = ?, last_error = ? WHERE id = ?",
			status, payload.RetryAtMS, payload.Error, payload.OutboxID,
		)
		return err
	case RecordKindHistoryAppended:
		var payload HistoryAppendedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		through := payload.FirstHistorySeq + int64(len(payload.MessageRecordIDs)) - 1
		if through < payload.FirstHistorySeq || payload.FirstHistorySeq != replayHistory[record.ConversationID]+1 {
			return errors.New("history append is not contiguous during replay")
		}
		replayHistory[record.ConversationID] = through
		if _, err := transaction.ExecContext(
			ctx,
			"UPDATE conversations SET next_history_seq = ?, updated_at_ms = ? WHERE id = ?",
			through+1, record.CreatedAt.UnixMilli(), record.ConversationID,
		); err != nil {
			return err
		}
		if payload.InputRevision == 0 {
			return nil
		}
		_, err := transaction.ExecContext(
			ctx,
			`UPDATE runs
SET handled_input_revision = MAX(handled_input_revision, ?), input_not_before_ms = NULL
WHERE id = ?`,
			payload.InputRevision, record.RunID,
		)
		return err
	case RecordKindInterruptRequested:
		var payload InterruptRequestedPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		_, err := transaction.ExecContext(
			ctx,
			`UPDATE runs
SET input_not_before_ms = COALESCE(input_not_before_ms, ?)
WHERE id = ?`,
			payload.InputNotBeforeMS, record.RunID,
		)
		return err
	case RecordKindContextCheckpoint:
		var payload ContextCheckpointPayload
		if err := json.Unmarshal(record.Payload, &payload); err != nil {
			return err
		}
		validSummary := (payload.Cause == "threshold" || payload.Cause == "overflow") &&
			len(payload.Replacement) > 0 && payload.SourceHistoryThroughSeq >= 1 &&
			payload.SourceInputRevision >= 1 && payload.EstimatedTokensAfter < payload.EstimatedTokensBefore
		validManual := payload.Cause == "manual" && len(payload.Replacement) > 0 &&
			payload.SourceHistoryThroughSeq >= 1 && payload.SourceInputRevision == 0 &&
			payload.EstimatedTokensAfter < payload.EstimatedTokensBefore
		validReset := payload.Cause == "new" && len(payload.Replacement) == 0 &&
			payload.SourceInputRevision == 0
		if !validSummary && !validManual && !validReset {
			return errors.New("context checkpoint payload is invalid")
		}
		if payload.SourceHistoryThroughSeq != replayHistory[record.ConversationID] {
			return errors.New("context checkpoint history boundary does not match replay history")
		}
		conversation, err := queries.GetConversation(ctx, record.ConversationID)
		if err != nil {
			return err
		}
		if conversation.ActiveContextCheckpointRecordID.String != payload.ParentRecordID {
			return errors.New("context checkpoint parent does not match active checkpoint")
		}
		if !conversation.ActiveSessionID.Valid {
			return errors.New("context checkpoint conversation has no active session")
		}
		if payload.SessionID == "" && payload.Cause == "new" {
			active, sessionErr := queries.GetActiveSession(ctx, record.ConversationID)
			if sessionErr != nil {
				return sessionErr
			}
			startRecord, startErr := queries.GetRecord(ctx, active.StartRecordID)
			if startErr != nil {
				return startErr
			}
			initialReset := payload.SourceHistoryThroughSeq == 0 && active.Ordinal == 1 &&
				active.StartHistorySeq == 1 && startRecord.Kind == string(RecordKindConversationCreated) &&
				startRecord.CommitID == record.CommitID
			if !initialReset {
				if switchErr := switchSession(
					ctx, queries, record.ConversationID, active.ID, record.ID, record.ID,
					payload.SourceHistoryThroughSeq+1, record.CreatedAt,
				); switchErr != nil {
					return switchErr
				}
				conversation.ActiveSessionID = sql.NullString{String: record.ID, Valid: true}
			}
		} else if payload.SessionID != "" && payload.SessionID != conversation.ActiveSessionID.String {
			return errors.New("context checkpoint session does not match active session")
		}
		_, err = transaction.ExecContext(
			ctx,
			"UPDATE conversations SET active_context_checkpoint_record_id = ?, updated_at_ms = ? WHERE id = ?",
			record.ID, record.CreatedAt.UnixMilli(), record.ConversationID,
		)
		return err
	case RecordKindIngressReceived, RecordKindResponseAdmitted,
		RecordKindCommandCompleted, RecordKindMemoryVersion:
		return nil
	default:
		return fmt.Errorf("unsupported record kind %q", record.Kind)
	}
}

func restoreRunTerminal(
	ctx context.Context,
	transaction *sql.Tx,
	record Record,
	status, code, message string,
) error {
	_, err := transaction.ExecContext(
		ctx,
		`UPDATE runs
SET status = ?, error_code = NULLIF(?, ''), error_message = NULLIF(?, ''), finished_at_ms = ?
WHERE id = ?`,
		status, code, message, record.CreatedAt.UnixMilli(), record.RunID,
	)
	return err
}
