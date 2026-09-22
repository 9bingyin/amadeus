package conversation

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/felinics/twilight/sdk"
)

func TestSessionSearchAndRead(t *testing.T) {
	store := openTestStore(t)
	route := Route{Platform: "telegram", AccountID: "bot-1", ChatID: "chat-1", ThreadID: ""}
	commitSessionMessage(t, store, route, "update-1", sdk.UserMessage("你好 sqlite trigram session search"), sdk.AssistantMessage("vector embeddings stay optional"))

	other := route
	other.ChatID = "chat-2"
	commitSessionMessage(t, store, other, "update-2", sdk.UserMessage("unrelated other chat"), sdk.AssistantMessage("do not return this"))

	matches, more, err := store.SearchSessions(t.Context(), route, "trigram", 20)
	if err != nil {
		t.Fatalf("SearchSessions() error = %v", err)
	}
	if more || len(matches) != 1 || matches[0].Ordinal != 1 || matches[0].Message != 1 || matches[0].Role != "user" || !strings.Contains(matches[0].Text, "trigram") {
		t.Fatalf("matches = %#v more=%v", matches, more)
	}
	if !matches[0].EndedAt.IsZero() {
		t.Fatal("open session has an end time")
	}

	short, _, err := store.SearchSessions(t.Context(), route, "你好", 20)
	if err != nil {
		t.Fatalf("SearchSessions() short error = %v", err)
	}
	if len(short) != 1 || short[0].Message != 1 || short[0].Role != "user" {
		t.Fatalf("short matches = %#v", short)
	}

	leaked, _, err := store.SearchSessions(t.Context(), route, "unrelated", 20)
	if err != nil {
		t.Fatalf("SearchSessions() leak error = %v", err)
	}
	if len(leaked) != 0 {
		t.Fatalf("leaked matches = %#v", leaked)
	}

	transcript, err := store.ReadSession(t.Context(), route, 1)
	if err != nil {
		t.Fatalf("ReadSession() error = %v", err)
	}
	if transcript.Ordinal != 1 || len(transcript.Messages) != 2 || transcript.Messages[1].Role != "assistant" {
		t.Fatalf("transcript = %#v", transcript)
	}
	if _, err := store.ReadSession(t.Context(), route, 2); err == nil || !strings.Contains(err.Error(), "session 2 was not found") {
		t.Fatalf("ReadSession() missing error = %v", err)
	}

	if err := store.RebuildProjections(t.Context()); err != nil {
		t.Fatalf("RebuildProjections() error = %v", err)
	}
	rebuilt, _, err := store.SearchSessions(t.Context(), route, "embeddings", 20)
	if err != nil {
		t.Fatalf("SearchSessions() rebuilt error = %v", err)
	}
	if len(rebuilt) != 1 || rebuilt[0].Message != 2 || rebuilt[0].Role != "assistant" {
		t.Fatalf("rebuilt matches = %#v", rebuilt)
	}
}

func commitSessionMessage(t *testing.T, store *Store, route Route, eventID string, user, assistant sdk.Message) {
	t.Helper()
	encoded, err := EncodeMessage(user)
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	accepted, err := store.Accept(t.Context(), AcceptInput{
		Route: route, SourceNamespace: "telegram:" + route.AccountID, SourceEventID: eventID,
		IngressPayload: json.RawMessage(`{"update_id":1}`), Message: encoded,
		Run: RunSpec{Provider: "openai-responses", Model: "gpt-test", SystemPrompt: "system"},
	})
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	_, err = store.CommitStep(t.Context(), CommitStepInput{
		RunID: accepted.RunID, Final: true,
		Step: &sdk.StepResult{
			FinishReason: sdk.FinishReasonStop,
			Messages:     []sdk.Message{assistant},
		},
		PlanOutbox: staticOutbox(OutboxChunk{Kind: "final", Payload: json.RawMessage(`{"text":"ok"}`)}),
	})
	if err != nil {
		t.Fatalf("CommitStep() error = %v", err)
	}
}
