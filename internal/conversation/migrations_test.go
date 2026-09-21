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

	"github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/felinics/twilight/sdk"
	"github.com/pressly/goose/v3"
)

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
		after.InputNotBeforeMs != before.InputNotBeforeMs {
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
