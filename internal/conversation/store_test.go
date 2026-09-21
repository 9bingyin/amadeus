package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/felinics/twilight/sdk"
)

func TestStoreAcceptsAndDeduplicatesMessage(t *testing.T) {
	store := openTestStore(t)
	input := testAcceptInput(t, "update-1", "chat-1", "")

	first, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	second, err := store.Accept(t.Context(), input)
	if err != nil {
		t.Fatalf("Accept() duplicate error = %v", err)
	}
	if !second.Duplicate || first.ConversationID != second.ConversationID || first.RunID != second.RunID ||
		first.MessageRecordID != second.MessageRecordID {
		t.Fatalf("first = %#v, second = %#v", first, second)
	}
	records, err := store.Records(t.Context())
	if err != nil {
		t.Fatalf("Records() error = %v", err)
	}
	route, err := store.ConversationRoute(t.Context(), first.ConversationID)
	if err != nil {
		t.Fatalf("ConversationRoute() error = %v", err)
	}
	if route.Platform != "telegram" || route.AccountID != "bot-1" || route.ChatID != "chat-1" {
		t.Fatalf("route = %#v", route)
	}
	if len(records) != 4 {
		t.Fatalf("records = %d, want 4", len(records))
	}
	for index, record := range records {
		if record.Seq != int64(index+1) {
			t.Fatalf("record %d seq = %d", index, record.Seq)
		}
	}
}

func TestStoreJoinsOpenRunAndSeparatesThreads(t *testing.T) {
	store := openTestStore(t)
	first, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", "thread-1"))
	if err != nil {
		t.Fatalf("Accept() first error = %v", err)
	}
	second, err := store.Accept(t.Context(), testAcceptInput(t, "update-2", "chat-1", "thread-1"))
	if err != nil {
		t.Fatalf("Accept() second error = %v", err)
	}
	otherThread, err := store.Accept(t.Context(), testAcceptInput(t, "update-3", "chat-1", "thread-2"))
	if err != nil {
		t.Fatalf("Accept() other thread error = %v", err)
	}
	if second.RunID != first.RunID || second.ConversationID != first.ConversationID {
		t.Fatalf("same thread runs differ: first=%#v second=%#v", first, second)
	}
	if otherThread.RunID == first.RunID || otherThread.ConversationID == first.ConversationID {
		t.Fatalf("different thread reused state: first=%#v other=%#v", first, otherThread)
	}
}

func TestStoreDeduplicatesConcurrentIngress(t *testing.T) {
	store := openTestStore(t)
	input := testAcceptInput(t, "update-1", "chat-1", "")
	results := make([]AcceptedMessage, 2)
	errorsByIndex := make([]error, 2)
	var wait sync.WaitGroup
	wait.Add(2)
	for index := range 2 {
		go func(index int) {
			defer wait.Done()
			results[index], errorsByIndex[index] = store.Accept(context.Background(), input)
		}(index)
	}
	wait.Wait()
	for _, err := range errorsByIndex {
		if err != nil {
			t.Fatalf("Accept() error = %v", err)
		}
	}
	if results[0].MessageRecordID != results[1].MessageRecordID || results[0].Duplicate == results[1].Duplicate {
		t.Fatalf("results = %#v", results)
	}
}

func TestStorePersistsFilePath(t *testing.T) {
	store := openTestStore(t)
	input := testAcceptInput(t, "update-1", "chat-1", "")
	path := "/tmp/amadeus/attachments/chat-1/note.txt"
	encoded, err := EncodeMessage(sdk.Message{Role: sdk.MessageRoleUser, Content: []sdk.MessagePart{sdk.FilePart{
		Data: encodeFileURL(path), MediaType: "text/plain", Filename: "note.txt",
	}}})
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	input.Message = encoded
	if _, err := store.Accept(t.Context(), input); err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	records, err := store.Records(t.Context())
	if err != nil {
		t.Fatalf("Records() error = %v", err)
	}
	found := false
	for _, record := range records {
		if record.Kind != RecordKindMessageCreated {
			continue
		}
		if !strings.Contains(string(record.Payload), path) {
			t.Fatalf("message payload = %s", record.Payload)
		}
		if strings.Contains(string(record.Payload), `"blob"`) {
			t.Fatalf("message payload still has blob: %s", record.Payload)
		}
		found = true
	}
	if !found {
		t.Fatal("message record was not stored")
	}
}

func TestStoreRecordsAreImmutable(t *testing.T) {
	store := openTestStore(t)
	accepted, err := store.Accept(t.Context(), testAcceptInput(t, "update-1", "chat-1", ""))
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if _, err := store.database.ExecContext(t.Context(), "UPDATE records SET kind = 'changed' WHERE id = ?", accepted.IngressRecordID); err == nil {
		t.Fatal("record update error = nil")
	}
	if _, err := store.database.ExecContext(t.Context(), "DELETE FROM records WHERE id = ?", accepted.IngressRecordID); err == nil {
		t.Fatal("record delete error = nil")
	}
}

func TestOpenSecuresDatabaseFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state.db")
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("database mode = %o, want 600", info.Mode().Perm())
	}
}

func TestOpenRejectsRelativePath(t *testing.T) {
	_, err := Open(t.Context(), "state.db")
	if err == nil {
		t.Fatal("Open() error = nil")
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			t.Errorf("Close() error = %v", err)
		}
	})
	return store
}

func testAcceptInput(t *testing.T, eventID, chatID, threadID string) AcceptInput {
	t.Helper()
	message, err := EncodeMessage(sdk.UserMessage("hello"))
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	return AcceptInput{
		Route:           Route{Platform: "telegram", AccountID: "bot-1", ChatID: chatID, ThreadID: threadID},
		SourceNamespace: "telegram:bot-1",
		SourceEventID:   eventID,
		IngressPayload:  json.RawMessage(`{"update_id":1}`),
		Message:         message,
		Run: RunSpec{
			Provider: "openai-responses", Model: "gpt-test", ReasoningEffort: "high", SystemPrompt: "system",
		},
	}
}
