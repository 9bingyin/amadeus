package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
)

const searchTrigramRunes = 3

type sqlExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type SearchDocument struct {
	RecordID       string
	ConversationID string
	Ordinal        int64
	Message        int
	Role           string
	Body           string
	StartedAt      time.Time
	EndedAt        time.Time
}

type SessionMatch struct {
	Ordinal   int64
	Message   int
	Role      string
	Text      string
	StartedAt time.Time
	EndedAt   time.Time
}

type SessionMessage struct {
	Role string
	Text string
}

type SessionTranscript struct {
	Ordinal   int64
	StartedAt time.Time
	EndedAt   time.Time
	Messages  []SessionMessage
}

func (s *Store) SearchSessions(
	ctx context.Context,
	route Route,
	query string,
	limit int,
) ([]SessionMatch, bool, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, false, errors.New("query is required")
	}
	if limit < 1 {
		return nil, false, errors.New("limit must be positive")
	}
	conversationID, err := s.conversationID(ctx, route)
	if err != nil {
		return nil, false, err
	}
	if conversationID == "" {
		return nil, false, nil
	}
	statement := searchLikeSQL
	args := []any{conversationID, query, limit + 1}
	if utf8.RuneCountInString(query) >= searchTrigramRunes {
		statement = searchMatchSQL
		args = []any{conversationID, ftsQuery(query), limit + 1}
	}
	rows, err := s.database.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, false, fmt.Errorf("search sessions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	matches, err := scanSessionMatches(rows)
	if err != nil {
		return nil, false, err
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("search sessions: %w", err)
	}
	more := len(matches) > limit
	if more {
		matches = matches[:limit]
	}
	return matches, more, nil
}

func (s *Store) ListSearchDocuments(ctx context.Context, route Route) ([]SearchDocument, error) {
	conversationID, err := s.conversationID(ctx, route)
	if err != nil {
		return nil, err
	}
	if conversationID == "" {
		return nil, nil
	}
	rows, err := s.database.QueryContext(ctx, listSearchDocumentsSQL, conversationID)
	if err != nil {
		return nil, fmt.Errorf("list session documents: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanSearchDocuments(rows)
}

func (s *Store) CountSearchDocuments(ctx context.Context, conversationID string) (int, error) {
	var count int
	err := s.database.QueryRowContext(ctx, `
SELECT COUNT(*) FROM message_search WHERE conversation_id = ?`, conversationID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count session documents: %w", err)
	}
	return count, nil
}

func (s *Store) ListAllSearchDocuments(ctx context.Context) ([]SearchDocument, error) {
	rows, err := s.database.QueryContext(ctx, listAllSearchDocumentsSQL)
	if err != nil {
		return nil, fmt.Errorf("list session documents: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanSearchDocuments(rows)
}

func scanSearchDocuments(rows *sql.Rows) ([]SearchDocument, error) {
	var documents []SearchDocument
	for rows.Next() {
		var document SearchDocument
		var started int64
		var ended sql.NullInt64
		if err := rows.Scan(
			&document.RecordID, &document.ConversationID, &document.Ordinal, &document.Role,
			&document.Body, &started, &ended,
		); err != nil {
			return nil, fmt.Errorf("list session documents: %w", err)
		}
		document.StartedAt = time.UnixMilli(started).UTC()
		if ended.Valid {
			document.EndedAt = time.UnixMilli(ended.Int64).UTC()
		}
		documents = append(documents, document)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list session documents: %w", err)
	}
	numberSearchDocuments(documents)
	return documents, nil
}

func numberSearchDocuments(documents []SearchDocument) {
	counts := make(map[sessionMessageKey]int, len(documents))
	for index := range documents {
		key := sessionMessageKey{documents[index].ConversationID, documents[index].Ordinal}
		counts[key]++
		documents[index].Message = counts[key]
	}
}

type sessionMessageKey struct {
	conversationID string
	ordinal        int64
}

func (s *Store) ReadSession(ctx context.Context, route Route, ordinal int64) (SessionTranscript, error) {
	if ordinal < 1 {
		return SessionTranscript{}, errors.New("session must be at least 1")
	}
	conversationID, err := s.conversationID(ctx, route)
	if err != nil {
		return SessionTranscript{}, err
	}
	if conversationID == "" {
		return SessionTranscript{}, fmt.Errorf("session %d was not found", ordinal)
	}
	var transcript SessionTranscript
	var started int64
	var ended sql.NullInt64
	err = s.database.QueryRowContext(ctx, readSessionSQL, conversationID, ordinal).Scan(
		&transcript.Ordinal, &started, &ended,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionTranscript{}, fmt.Errorf("session %d was not found", ordinal)
	}
	if err != nil {
		return SessionTranscript{}, fmt.Errorf("read session %d: %w", ordinal, err)
	}
	transcript.StartedAt = time.UnixMilli(started).UTC()
	if ended.Valid {
		transcript.EndedAt = time.UnixMilli(ended.Int64).UTC()
	}
	rows, err := s.database.QueryContext(ctx, readSessionMessagesSQL, conversationID, ordinal)
	if err != nil {
		return SessionTranscript{}, fmt.Errorf("read session %d: %w", ordinal, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var message SessionMessage
		if err := rows.Scan(&message.Role, &message.Text); err != nil {
			return SessionTranscript{}, fmt.Errorf("read session %d: %w", ordinal, err)
		}
		transcript.Messages = append(transcript.Messages, message)
	}
	if err := rows.Err(); err != nil {
		return SessionTranscript{}, fmt.Errorf("read session %d: %w", ordinal, err)
	}
	return transcript, nil
}

func (s *Store) conversationID(ctx context.Context, route Route) (string, error) {
	if route.Platform == "" || route.AccountID == "" || route.ChatID == "" {
		return "", errors.New("conversation route is incomplete")
	}
	row, err := conversationdb.New(s.database).GetConversationByRoute(ctx, conversationdb.GetConversationByRouteParams{
		Platform: route.Platform, AccountID: route.AccountID,
		ExternalChatID: route.ChatID, ExternalThreadID: route.ThreadID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("load conversation: %w", err)
	}
	return row.ID, nil
}

func backfillSearch(ctx context.Context, database *sql.DB) error {
	rows, err := database.QueryContext(ctx, `
SELECT m.record_id, m.conversation_id, r.payload_json
FROM messages m
JOIN records r ON r.id = m.record_id
WHERE m.history_seq IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM message_search s WHERE s.message_record_id = m.record_id
  )`)
	if err != nil {
		return fmt.Errorf("list unindexed session messages: %w", err)
	}
	type pendingIndex struct {
		recordID       string
		conversationID string
		payload        string
	}
	var pending []pendingIndex
	for rows.Next() {
		var item pendingIndex
		if err := rows.Scan(&item.recordID, &item.conversationID, &item.payload); err != nil {
			_ = rows.Close()
			return fmt.Errorf("list unindexed session messages: %w", err)
		}
		pending = append(pending, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("list unindexed session messages: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("list unindexed session messages: %w", err)
	}
	if len(pending) == 0 {
		return nil
	}
	transaction, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin session search backfill: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	for _, item := range pending {
		if err := indexSearchMessage(ctx, transaction, item.recordID, item.conversationID, item.payload); err != nil {
			return err
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit session search backfill: %w", err)
	}
	return nil
}

func indexSearchMessage(
	ctx context.Context,
	exec sqlExecer,
	recordID, conversationID, payload string,
) error {
	role, body, ok, err := searchText(payload)
	if err != nil {
		return fmt.Errorf("index session search %s: %w", recordID, err)
	}
	if !ok {
		if _, err := exec.ExecContext(ctx, `DELETE FROM message_search WHERE message_record_id = ?`, recordID); err != nil {
			return fmt.Errorf("clear session search %s: %w", recordID, err)
		}
		return nil
	}
	_, err = exec.ExecContext(ctx, `
INSERT INTO message_search (message_record_id, conversation_id, role, body)
VALUES (?, ?, ?, ?)
ON CONFLICT (message_record_id) DO UPDATE SET
    conversation_id = excluded.conversation_id,
    role = excluded.role,
    body = excluded.body`, recordID, conversationID, role, body)
	if err != nil {
		return fmt.Errorf("index session search %s: %w", recordID, err)
	}
	return nil
}

func searchText(payload string) (role, body string, ok bool, err error) {
	var stored MessageRecordPayload
	if err := json.Unmarshal([]byte(payload), &stored); err != nil {
		return "", "", false, fmt.Errorf("decode message: %w", err)
	}
	role = stored.Message.Role
	if role != string(sdk.MessageRoleUser) && role != string(sdk.MessageRoleAssistant) {
		return "", "", false, nil
	}
	var builder strings.Builder
	for _, part := range stored.Message.Parts {
		if part.Type != PartTypeText || part.Text == nil {
			continue
		}
		text := strings.TrimSpace(part.Text.Text)
		if text == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteByte('\n')
		}
		builder.WriteString(text)
	}
	body = builder.String()
	if body == "" {
		return "", "", false, nil
	}
	return role, body, true, nil
}

func ftsQuery(query string) string {
	return `"` + strings.ReplaceAll(query, `"`, `""`) + `"`
}

func scanSessionMatches(rows *sql.Rows) ([]SessionMatch, error) {
	var matches []SessionMatch
	for rows.Next() {
		var match SessionMatch
		var started int64
		var ended sql.NullInt64
		if err := rows.Scan(&match.Ordinal, &match.Message, &match.Role, &match.Text, &started, &ended); err != nil {
			return nil, fmt.Errorf("search sessions: %w", err)
		}
		match.StartedAt = time.UnixMilli(started).UTC()
		if ended.Valid {
			match.EndedAt = time.UnixMilli(ended.Int64).UTC()
		}
		matches = append(matches, match)
	}
	return matches, nil
}

const sessionJoinSQL = `
JOIN messages m ON m.record_id = ms.message_record_id
JOIN sessions sess ON sess.conversation_id = m.conversation_id
  AND m.history_seq >= sess.start_history_seq
  AND (sess.end_history_seq IS NULL OR m.history_seq <= sess.end_history_seq)`

const numberedSessionMessagesSQL = `
SELECT sess.ordinal AS ordinal,
       ROW_NUMBER() OVER (PARTITION BY sess.ordinal ORDER BY m.history_seq) AS message_no,
       ms.role AS role,
       ms.body AS body,
       sess.started_at_ms AS started_at_ms,
       sess.ended_at_ms AS ended_at_ms,
       m.history_seq AS history_seq,
       ms.id AS id
FROM message_search ms
` + sessionJoinSQL + `
WHERE ms.conversation_id = ?`

const searchMatchSQL = `
WITH numbered AS (
` + numberedSessionMessagesSQL + `
)
SELECT numbered.ordinal, numbered.message_no, numbered.role, numbered.body, numbered.started_at_ms, numbered.ended_at_ms
FROM numbered
JOIN message_fts ON message_fts.rowid = numbered.id
WHERE message_fts MATCH ?
ORDER BY numbered.history_seq
LIMIT ?`

const searchLikeSQL = `
WITH numbered AS (
` + numberedSessionMessagesSQL + `
)
SELECT numbered.ordinal, numbered.message_no, numbered.role, numbered.body, numbered.started_at_ms, numbered.ended_at_ms
FROM numbered
WHERE instr(lower(numbered.body), lower(?)) > 0
ORDER BY numbered.history_seq
LIMIT ?`

const listSearchDocumentsSQL = `
SELECT ms.message_record_id, ms.conversation_id, sess.ordinal, ms.role, ms.body,
       sess.started_at_ms, sess.ended_at_ms
FROM message_search ms
` + sessionJoinSQL + `
WHERE ms.conversation_id = ?
ORDER BY m.history_seq`

const listAllSearchDocumentsSQL = `
SELECT ms.message_record_id, ms.conversation_id, sess.ordinal, ms.role, ms.body,
       sess.started_at_ms, sess.ended_at_ms
FROM message_search ms
` + sessionJoinSQL + `
ORDER BY m.history_seq`

const readSessionSQL = `
SELECT ordinal, started_at_ms, ended_at_ms
FROM sessions
WHERE conversation_id = ? AND ordinal = ?`

const readSessionMessagesSQL = `
SELECT ms.role, ms.body
FROM message_search ms
` + sessionJoinSQL + `
WHERE sess.conversation_id = ? AND sess.ordinal = ?
ORDER BY m.history_seq`
