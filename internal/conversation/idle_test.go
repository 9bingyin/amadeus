package conversation

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/felinics/twilight/sdk"
)

func TestListConversationUserActivity(t *testing.T) {
	store := openTestStore(t)
	userAt := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	localAt := userAt.Add(time.Hour)
	store.now = func() time.Time { return userAt }

	idle := testAcceptInput(t, "user-1", "idle-chat", "")
	if _, err := store.Accept(t.Context(), idle); err != nil {
		t.Fatalf("Accept() idle error = %v", err)
	}
	started, err := store.StartNextRun(t.Context())
	if err != nil || started == nil {
		t.Fatalf("StartNextRun() = %#v, %v", started, err)
	}
	if err := store.FailRun(t.Context(), started.ID, "test", "stopped", testErrorReply); err != nil {
		t.Fatalf("FailRun() error = %v", err)
	}

	store.now = func() time.Time { return localAt }
	localMessage, err := EncodeMessage(sdk.UserMessage("report"))
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	local := AcceptInput{
		Route:           Route{Platform: "telegram", AccountID: "bot-1", ChatID: "idle-chat"},
		SourceNamespace: "local", SourceEventID: "local-1",
		IngressPayload: json.RawMessage(`{"text":"report"}`),
		Message:        localMessage,
		Run:            idle.Run,
	}
	if _, err := store.Accept(t.Context(), local); err != nil {
		t.Fatalf("Accept() local error = %v", err)
	}
	localRun, err := store.StartNextRun(t.Context())
	if err != nil || localRun == nil || localRun.ConversationID == "" {
		t.Fatalf("StartNextRun() local = %#v, %v", localRun, err)
	}
	if err := store.FailRun(t.Context(), localRun.ID, "test", "stopped", testErrorReply); err != nil {
		t.Fatalf("FailRun() local error = %v", err)
	}
	busy := testAcceptInput(t, "user-2", "busy-chat", "")
	if _, err := store.Accept(t.Context(), busy); err != nil {
		t.Fatalf("Accept() busy error = %v", err)
	}
	busyRun, err := store.StartNextRun(t.Context())
	if err != nil || busyRun == nil {
		t.Fatalf("StartNextRun() busy = %#v, %v", busyRun, err)
	}
	if err := store.FailRun(t.Context(), busyRun.ID, "test", "stopped", testErrorReply); err != nil {
		t.Fatalf("FailRun() busy error = %v", err)
	}
	if _, err := store.Accept(t.Context(), testAcceptInput(t, "user-3", "busy-chat", "")); err != nil {
		t.Fatalf("Accept() busy follow-up error = %v", err)
	}

	activity, err := store.ListConversationUserActivity(t.Context(), "local")
	if err != nil {
		t.Fatalf("ListConversationUserActivity() error = %v", err)
	}
	if len(activity) != 2 {
		t.Fatalf("activity = %#v, want idle and busy chats", activity)
	}
	var quiet, busyActivity ConversationActivity
	for _, row := range activity {
		switch row.Route.ChatID {
		case "idle-chat":
			quiet = row
		case "busy-chat":
			busyActivity = row
		default:
			t.Fatalf("activity = %#v", activity)
		}
	}
	if quiet.Busy || !quiet.LastUserAt.Equal(userAt) {
		t.Fatalf("idle chat = %#v, want quiet at %s", quiet, userAt)
	}
	if !busyActivity.Busy || !busyActivity.LastUserAt.Equal(localAt) {
		t.Fatalf("busy chat = %#v, want busy at %s", busyActivity, localAt)
	}
}

func testErrorReply(FinalReply) ([]ReplyChunk, error) {
	return []ReplyChunk{{Kind: "error", Payload: json.RawMessage(`{"text":"stopped"}`)}}, nil
}
