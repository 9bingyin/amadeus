package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	conversationdb "github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
	"github.com/pressly/goose/v3"
)

func TestContextCommandMigrationPreservesExistingOutbox(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	database, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	files := fstest.MapFS{}
	for _, name := range []string{
		"00001_initial.sql", "00002_input_window.sql", "00003_context_checkpoint.sql",
	} {
		migration, readErr := fs.ReadFile(migrationFiles, "migrations/"+name)
		if readErr != nil {
			t.Fatalf("read migration %s: %v", name, readErr)
		}
		files[name] = &fstest.MapFile{Data: migration}
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, database, files)
	if err != nil {
		t.Fatalf("goose.NewProvider() error = %v", err)
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatalf("apply pre-command migrations: %v", err)
	}
	seedLegacyQueuedRun(t, database)
	seedLegacyOutbox(t, database)
	if err := database.Close(); err != nil {
		t.Fatalf("close pre-command database: %v", err)
	}

	upgraded, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("Open() upgraded database error = %v", err)
	}
	t.Cleanup(func() {
		if err := upgraded.Close(); err != nil {
			t.Errorf("upgraded.Close() error = %v", err)
		}
	})
	pending, err := upgraded.PendingReply(t.Context(), time.Now().Add(time.Minute))
	if err != nil || len(pending) != 1 || pending[0].Kind != "final" || pending[0].RunID != "run-1" {
		t.Fatalf("upgraded outbox = %#v, %v", pending, err)
	}
}

func TestSessionMigrationMatchesProjectionRebuild(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	database, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	files := fstest.MapFS{}
	for _, name := range []string{
		"00001_initial.sql", "00002_input_window.sql", "00003_context_checkpoint.sql",
		"00004_context_commands.sql",
	} {
		migration, readErr := fs.ReadFile(migrationFiles, "migrations/"+name)
		if readErr != nil {
			t.Fatalf("read migration %s: %v", name, readErr)
		}
		files[name] = &fstest.MapFile{Data: migration}
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, database, files)
	if err != nil {
		t.Fatalf("goose.NewProvider() error = %v", err)
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatalf("apply pre-session migrations: %v", err)
	}
	seedLegacyQueuedRun(t, database)
	seedLegacyEmptyResets(t, database)
	queries := conversationdb.New(database)
	now := time.Unix(1_700_000_002, 0).UTC()
	historyPayload, err := json.Marshal(HistoryAppendedPayload{
		FirstHistorySeq: 1, MessageRecordIDs: []string{"message-1"}, InputRevision: 1,
	})
	if err != nil {
		t.Fatalf("marshal history payload: %v", err)
	}
	completedPayload, err := json.Marshal(RunStatusPayload{Status: "completed"})
	if err != nil {
		t.Fatalf("marshal completed payload: %v", err)
	}
	checkpointPayload, err := json.Marshal(ContextCheckpointPayload{
		Cause: "new", SourceHistoryThroughSeq: 1, Replacement: []MessageDTO{},
	})
	if err != nil {
		t.Fatalf("marshal checkpoint payload: %v", err)
	}
	for _, record := range []Record{
		legacyRecord(t, "history-1", "commit-history", RecordKindHistoryAppended,
			historyPayload, now, "conversation-1", "run-1"),
		legacyRecord(t, "run-completed", "commit-completed", RecordKindRunCompleted,
			completedPayload, now, "conversation-1", "run-1"),
		legacyRecord(t, "checkpoint-new", "commit-new", RecordKindContextCheckpoint,
			checkpointPayload, now, "conversation-1", ""),
	} {
		if _, err := appendRecord(t.Context(), queries, record); err != nil {
			t.Fatalf("append %s: %v", record.ID, err)
		}
	}
	if _, err := database.ExecContext(t.Context(), `
UPDATE messages SET history_seq = 1, committed_at_ms = ? WHERE record_id = 'message-1';
UPDATE conversations
SET next_history_seq = 2, active_context_checkpoint_record_id = 'checkpoint-new'
WHERE id = 'conversation-1';
UPDATE runs SET status = 'completed', finished_at_ms = ? WHERE id = 'run-1';`, now.UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatalf("update legacy projections: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close pre-session database: %v", err)
	}

	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("Open() upgraded database error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("store.Close() error = %v", err)
		}
	})
	assertLegacySessionProjection(t, store)
	assertLegacyEmptyResetProjection(t, store)
	if err := store.RebuildProjections(t.Context()); err != nil {
		t.Fatalf("RebuildProjections() error = %v", err)
	}
	assertLegacySessionProjection(t, store)
	assertLegacyEmptyResetProjection(t, store)
}

func seedLegacyEmptyResets(t *testing.T, database *sql.DB) {
	t.Helper()
	ctx := t.Context()
	queries := conversationdb.New(database)
	now := time.Unix(1_700_000_003, 0).UTC()
	conversationPayload, err := json.Marshal(ConversationCreatedPayload{
		Platform: "telegram", AccountID: "bot-1", ExternalChatID: "chat-empty",
	})
	if err != nil {
		t.Fatalf("marshal empty conversation payload: %v", err)
	}
	initialPayload, err := json.Marshal(ContextCheckpointPayload{
		Cause: "new", SourceHistoryThroughSeq: 0, Replacement: []MessageDTO{},
	})
	if err != nil {
		t.Fatalf("marshal initial empty checkpoint: %v", err)
	}
	secondPayload, err := json.Marshal(ContextCheckpointPayload{
		Cause: "new", ParentRecordID: "empty-initial-reset",
		SourceHistoryThroughSeq: 0, Replacement: []MessageDTO{},
	})
	if err != nil {
		t.Fatalf("marshal second empty checkpoint: %v", err)
	}
	for _, record := range []Record{
		legacyRecord(t, "empty-conversation-record", "empty-initial-commit",
			RecordKindConversationCreated, conversationPayload, now, "empty-conversation", ""),
		legacyRecord(t, "empty-initial-reset", "empty-initial-commit",
			RecordKindContextCheckpoint, initialPayload, now, "empty-conversation", ""),
		legacyRecord(t, "empty-second-reset", "empty-second-commit",
			RecordKindContextCheckpoint, secondPayload, now.Add(time.Millisecond), "empty-conversation", ""),
	} {
		if _, err := appendRecord(ctx, queries, record); err != nil {
			t.Fatalf("append empty reset record %s: %v", record.ID, err)
		}
	}
	if _, err := database.ExecContext(ctx, `
INSERT INTO conversations (
    id, platform, account_id, external_chat_id, external_thread_id,
    next_history_seq, created_at_ms, updated_at_ms, active_context_checkpoint_record_id
) VALUES ('empty-conversation', 'telegram', 'bot-1', 'chat-empty', '', 1, ?, ?, 'empty-second-reset')`,
		now.UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatalf("insert empty reset conversation: %v", err)
	}
}

func assertLegacyEmptyResetProjection(t *testing.T, store *Store) {
	t.Helper()
	queries := conversationdb.New(store.database)
	conversation, err := queries.GetConversation(t.Context(), "empty-conversation")
	if err != nil || !conversation.ActiveSessionID.Valid ||
		conversation.ActiveSessionID.String != "empty-second-reset" {
		t.Fatalf("empty active session = %#v, %v", conversation.ActiveSessionID, err)
	}
	initial, err := queries.GetSession(t.Context(), "empty-conversation")
	if err != nil || initial.EndHistorySeq.Int64 != 0 ||
		initial.EndRecordID.String != "empty-second-reset" {
		t.Fatalf("empty initial session = %#v, %v", initial, err)
	}
	active, err := queries.GetSession(t.Context(), "empty-second-reset")
	if err != nil || active.Ordinal != 2 || active.StartHistorySeq != 1 || active.EndRecordID.Valid {
		t.Fatalf("empty second session = %#v, %v", active, err)
	}
}

func assertLegacySessionProjection(t *testing.T, store *Store) {
	t.Helper()
	queries := conversationdb.New(store.database)
	conversation, err := queries.GetConversation(t.Context(), "conversation-1")
	if err != nil || !conversation.ActiveSessionID.Valid ||
		conversation.ActiveSessionID.String != "checkpoint-new" {
		t.Fatalf("active session = %#v, %v", conversation.ActiveSessionID, err)
	}
	initial, err := queries.GetSession(t.Context(), "conversation-1")
	if err != nil || initial.EndHistorySeq.Int64 != 1 ||
		initial.EndRecordID.String != "checkpoint-new" {
		t.Fatalf("initial session = %#v, %v", initial, err)
	}
	active, err := queries.GetSession(t.Context(), "checkpoint-new")
	if err != nil || active.Ordinal != 2 || active.StartHistorySeq != 2 || active.EndRecordID.Valid {
		t.Fatalf("active session = %#v, %v", active, err)
	}
	run, err := queries.GetRun(t.Context(), "run-1")
	if err != nil || !run.SessionID.Valid || run.SessionID.String != "conversation-1" {
		t.Fatalf("run session = %#v, %v", run.SessionID, err)
	}
}

func TestInputWindowMigrationMatchesProjectionRebuild(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	database, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	migration, err := fs.ReadFile(migrationFiles, "migrations/00001_initial.sql")
	if err != nil {
		t.Fatalf("read initial migration: %v", err)
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, database, fstest.MapFS{
		"00001_initial.sql": &fstest.MapFile{Data: migration},
	})
	if err != nil {
		t.Fatalf("goose.NewProvider() error = %v", err)
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatalf("apply initial migration: %v", err)
	}
	seedLegacyQueuedRun(t, database)
	if err := database.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("Open() upgraded database error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("store.Close() error = %v", err)
		}
	})
	queries := conversationdb.New(store.database)
	upgraded, err := queries.GetRun(t.Context(), "run-1")
	if err != nil {
		t.Fatalf("GetRun() upgraded error = %v", err)
	}
	if upgraded.InputRevision != 1 || upgraded.HandledInputRevision != 0 {
		t.Fatalf("upgraded revisions = %d/%d, want 1/0", upgraded.InputRevision, upgraded.HandledInputRevision)
	}
	if !upgraded.SessionID.Valid || upgraded.SessionID.String != "conversation-1" {
		t.Fatalf("upgraded session = %#v, want conversation-1", upgraded.SessionID)
	}
	conversation, err := queries.GetConversation(t.Context(), "conversation-1")
	if err != nil || !conversation.ActiveSessionID.Valid ||
		conversation.ActiveSessionID.String != "conversation-1" {
		t.Fatalf("upgraded active session = %#v, %v", conversation.ActiveSessionID, err)
	}

	input := testAcceptInput(t, "update-2", "chat-1", "")
	if _, err := store.Accept(t.Context(), input); err != nil {
		t.Fatalf("Accept() after upgrade error = %v", err)
	}
	before, err := queries.GetRun(t.Context(), "run-1")
	if err != nil {
		t.Fatalf("GetRun() before rebuild error = %v", err)
	}
	if err := store.RebuildProjections(t.Context()); err != nil {
		t.Fatalf("RebuildProjections() error = %v", err)
	}
	after, err := queries.GetRun(t.Context(), "run-1")
	if err != nil {
		t.Fatalf("GetRun() after rebuild error = %v", err)
	}
	if after.InputRevision != before.InputRevision ||
		after.HandledInputRevision != before.HandledInputRevision ||
		after.InputNotBeforeMs != before.InputNotBeforeMs ||
		after.SessionID != before.SessionID {
		t.Fatalf("rebuilt input state = %#v, want %#v", after, before)
	}
}

func seedLegacyQueuedRun(t *testing.T, database *sql.DB) {
	t.Helper()
	ctx := context.Background()
	queries := conversationdb.New(database)
	now := time.Unix(1_700_000_000, 0).UTC()
	conversationPayload, err := json.Marshal(ConversationCreatedPayload{
		Platform: "telegram", AccountID: "bot-1", ExternalChatID: "chat-1",
	})
	if err != nil {
		t.Fatalf("marshal conversation payload: %v", err)
	}
	runPayload, err := json.Marshal(RunCreatedPayload{
		Provider: "openai-responses", Model: "gpt-test", SystemPrompt: "system",
	})
	if err != nil {
		t.Fatalf("marshal run payload: %v", err)
	}
	encoded, err := EncodeMessage(sdk.UserMessage("hello"))
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	messagePayload, err := json.Marshal(MessageRecordPayload{
		Message: encoded.Message, SourceRecordID: "ingress-1",
	})
	if err != nil {
		t.Fatalf("marshal message payload: %v", err)
	}
	records := []Record{
		legacyRecord(t, "conversation-record", "commit-1", RecordKindConversationCreated, conversationPayload, now, "conversation-1", ""),
		legacyRecord(t, "run-record", "commit-2", RecordKindRunCreated, runPayload, now, "conversation-1", "run-1"),
		legacyRecord(t, "ingress-1", "commit-3", RecordKindIngressReceived, json.RawMessage(`{"update_id":1}`), now, "conversation-1", "run-1"),
		legacyRecord(t, "message-1", "commit-3", RecordKindMessageCreated, messagePayload, now, "conversation-1", "run-1"),
	}
	records[2].SourceNamespace = "telegram:bot-1"
	records[2].SourceEventID = "update-1"
	var queueSeq int64
	for _, record := range records {
		seq, appendErr := appendRecord(ctx, queries, record)
		if appendErr != nil {
			t.Fatalf("append legacy record %s: %v", record.ID, appendErr)
		}
		if record.Kind == RecordKindRunCreated {
			queueSeq = seq
		}
	}
	if _, err := database.ExecContext(ctx, `
INSERT INTO conversations (
    id, platform, account_id, external_chat_id, external_thread_id,
    next_history_seq, created_at_ms, updated_at_ms
) VALUES ('conversation-1', 'telegram', 'bot-1', 'chat-1', '', 1, ?, ?)`, now.UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatalf("insert legacy conversation: %v", err)
	}
	if _, err := database.ExecContext(ctx, `
INSERT INTO runs (
    id, conversation_id, queue_seq, status, provider, model,
    reasoning_effort, system_prompt, config_json, next_step_seq, created_at_ms
) VALUES ('run-1', 'conversation-1', ?, 'queued', 'openai-responses', 'gpt-test', NULL, 'system', NULL, 0, ?)`, queueSeq, now.UnixMilli()); err != nil {
		t.Fatalf("insert legacy run: %v", err)
	}
	if _, err := database.ExecContext(ctx, `
INSERT INTO messages (
    record_id, conversation_id, run_id, source_record_id, role,
    history_seq, step_seq, step_message_seq, committed_at_ms
) VALUES ('message-1', 'conversation-1', 'run-1', 'ingress-1', 'user', NULL, NULL, NULL, NULL)`); err != nil {
		t.Fatalf("insert legacy message: %v", err)
	}
}

func seedLegacyOutbox(t *testing.T, database *sql.DB) {
	t.Helper()
	ctx := context.Background()
	queries := conversationdb.New(database)
	now := time.Unix(1_700_000_001, 0).UTC()
	payload, err := json.Marshal(ReplyPlannedPayload{
		OutboxID: "outbox-1", MessageRecordID: "message-1", Kind: "final",
		ChunkIndex: 0, ChunkCount: 1, Payload: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("marshal outbox payload: %v", err)
	}
	record := legacyRecord(
		t, "outbox-record", "commit-outbox", RecordKindReplyPlanned,
		payload, now, "conversation-1", "run-1",
	)
	seq, err := appendRecord(ctx, queries, record)
	if err != nil {
		t.Fatalf("append legacy outbox record: %v", err)
	}
	if _, err := database.ExecContext(ctx, `
INSERT INTO outbox (
    id, record_id, enqueue_seq, conversation_id, run_id, message_record_id,
    kind, chunk_index, chunk_count, status, attempts, available_at_ms, created_at_ms
) VALUES ('outbox-1', 'outbox-record', ?, 'conversation-1', 'run-1', 'message-1',
          'final', 0, 1, 'pending', 0, ?, ?)`, seq, now.UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatalf("insert legacy outbox: %v", err)
	}
}

func legacyRecord(
	t *testing.T,
	id, commitID string,
	kind RecordKind,
	payload json.RawMessage,
	createdAt time.Time,
	conversationID, runID string,
) Record {
	t.Helper()
	record, err := newRecord(id, commitID, kind, payload, createdAt)
	if err != nil {
		t.Fatalf("newRecord(%s) error = %v", kind, err)
	}
	record.ConversationID = conversationID
	record.RunID = runID
	return record
}
