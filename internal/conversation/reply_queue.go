package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	conversationdb "github.com/9bingyin/amadeus/internal/conversation/db"
)

type ReplyChunk struct {
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

type ReplyPlanner func(FinalReply) ([]ReplyChunk, error)

type PendingReply struct {
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

func (s *Store) NextReplyAt(ctx context.Context) (time.Time, bool, error) {
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

func (s *Store) PendingReply(ctx context.Context, now time.Time) ([]PendingReply, error) {
	rows, err := conversationdb.New(s.database).ListPendingOutboxHeads(ctx, now.UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("list pending outbox: %w", err)
	}
	pending := make([]PendingReply, len(rows))
	for index, row := range rows {
		var payload ReplyPlannedPayload
		if err := json.Unmarshal([]byte(row.PayloadJson), &payload); err != nil {
			return nil, fmt.Errorf("decode outbox %s: %w", row.ID, err)
		}
		pending[index] = PendingReply{
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

func (s *Store) enqueueReply(
	ctx context.Context,
	queries *conversationdb.Queries,
	run conversationdb.Run,
	commitID string,
	now time.Time,
	messageRecordID, kind, text string,
	planReply ReplyPlanner,
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
	chunks, err := planReply(FinalReply{
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
		payload, marshalErr := json.Marshal(ReplyPlannedPayload{
			OutboxID: outboxID, MessageRecordID: messageRecordID, ReplyToRecordID: latestUser.RecordID,
			Kind: chunk.Kind, ChunkIndex: index, ChunkCount: len(chunks), Payload: chunk.Payload,
		})
		if marshalErr != nil {
			return fmt.Errorf("encode %s outbox record: %w", kind, marshalErr)
		}
		record, recordErr := newRecord(recordID, commitID, RecordKindReplyPlanned, payload, now)
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
