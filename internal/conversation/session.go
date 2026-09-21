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

func (s *Store) EnsureConversation(
	ctx context.Context,
	route Route,
) (conversationID, sessionID string, err error) {
	if err := normalizeRoute(&route); err != nil {
		return "", "", err
	}
	conversationID, err = s.newID()
	if err != nil {
		return "", "", fmt.Errorf("generate conversation ID: %w", err)
	}
	recordID, err := s.newID()
	if err != nil {
		return "", "", fmt.Errorf("generate conversation record ID: %w", err)
	}
	commitID, err := s.newID()
	if err != nil {
		return "", "", fmt.Errorf("generate conversation commit ID: %w", err)
	}
	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return "", "", fmt.Errorf("begin ensuring conversation: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)
	now := s.now().UTC()
	conversation, err := queries.UpsertConversation(ctx, conversationdb.UpsertConversationParams{
		ID: conversationID, Platform: route.Platform, AccountID: route.AccountID,
		ExternalChatID: route.ChatID, ExternalThreadID: route.ThreadID,
		CreatedAtMs: now.UnixMilli(), UpdatedAtMs: now.UnixMilli(),
	})
	if err != nil {
		return "", "", fmt.Errorf("upsert conversation: %w", err)
	}
	if conversation.ID == conversationID {
		payload, marshalErr := json.Marshal(ConversationCreatedPayload{
			Platform: route.Platform, AccountID: route.AccountID,
			ExternalChatID: route.ChatID, ExternalThreadID: route.ThreadID,
		})
		if marshalErr != nil {
			return "", "", fmt.Errorf("encode conversation record: %w", marshalErr)
		}
		record, recordErr := newRecord(
			recordID, commitID, RecordKindConversationCreated, payload, now,
		)
		if recordErr != nil {
			return "", "", recordErr
		}
		record.ConversationID = conversationID
		if _, appendErr := appendRecord(ctx, queries, record); appendErr != nil {
			return "", "", appendErr
		}
		if sessionErr := createInitialSession(
			ctx, queries, conversationID, recordID, now,
		); sessionErr != nil {
			return "", "", sessionErr
		}
		sessionID = conversationID
	} else {
		conversationID = conversation.ID
		if !conversation.ActiveSessionID.Valid {
			return "", "", errors.New("conversation has no active session")
		}
		sessionID = conversation.ActiveSessionID.String
	}
	if err := transaction.Commit(); err != nil {
		return "", "", fmt.Errorf("commit ensuring conversation: %w", err)
	}
	return conversationID, sessionID, nil
}

func createInitialSession(
	ctx context.Context,
	queries *conversationdb.Queries,
	conversationID, startRecordID string,
	now time.Time,
) error {
	if err := queries.InsertSession(ctx, conversationdb.InsertSessionParams{
		ID: conversationID, ConversationID: conversationID, Ordinal: 1,
		StartRecordID: startRecordID, StartHistorySeq: 1, StartedAtMs: now.UnixMilli(),
	}); err != nil {
		return fmt.Errorf("insert initial session: %w", err)
	}
	updated, err := queries.SetActiveSession(ctx, conversationdb.SetActiveSessionParams{
		SessionID:   sql.NullString{String: conversationID, Valid: true},
		UpdatedAtMs: now.UnixMilli(), ConversationID: conversationID,
		PreviousSessionID: sql.NullString{String: "", Valid: true},
	})
	if err != nil {
		return fmt.Errorf("activate initial session: %w", err)
	}
	if updated != 1 {
		return errors.New("activate initial session: state changed")
	}
	return nil
}

func switchSession(
	ctx context.Context,
	queries *conversationdb.Queries,
	conversationID, previousSessionID, sessionID, startRecordID string,
	startHistorySeq int64,
	now time.Time,
) error {
	previous, err := queries.GetSession(ctx, previousSessionID)
	if err != nil {
		return fmt.Errorf("load previous session: %w", err)
	}
	if previous.ConversationID != conversationID || previous.EndRecordID.Valid {
		return errors.New("previous session is not active for conversation")
	}
	closed, err := queries.CloseSession(ctx, conversationdb.CloseSessionParams{
		EndRecordID:   sql.NullString{String: startRecordID, Valid: true},
		EndHistorySeq: sql.NullInt64{Int64: startHistorySeq - 1, Valid: true},
		EndedAtMs:     sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		ID:            previousSessionID, ConversationID: conversationID,
	})
	if err != nil {
		return fmt.Errorf("close previous session: %w", err)
	}
	if closed != 1 {
		return errors.New("close previous session: state changed")
	}
	if err := queries.InsertSession(ctx, conversationdb.InsertSessionParams{
		ID: sessionID, ConversationID: conversationID, Ordinal: previous.Ordinal + 1,
		StartRecordID: startRecordID, StartHistorySeq: startHistorySeq,
		StartedAtMs: now.UnixMilli(),
	}); err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	updated, err := queries.SetActiveSession(ctx, conversationdb.SetActiveSessionParams{
		SessionID:   sql.NullString{String: sessionID, Valid: true},
		UpdatedAtMs: now.UnixMilli(), ConversationID: conversationID,
		PreviousSessionID: sql.NullString{String: previousSessionID, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("activate session: %w", err)
	}
	if updated != 1 {
		return errors.New("activate session: state changed")
	}
	return nil
}
