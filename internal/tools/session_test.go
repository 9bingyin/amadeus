package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/felinics/twilight/sdk"
)

func TestSessionToolsSearchAndRead(t *testing.T) {
	store := openSessionStore(t)
	route := conversation.Route{Platform: "telegram", AccountID: "bot-1", ChatID: "chat-1"}
	tools, err := NewSessionTools(store, nil)
	if err != nil {
		t.Fatalf("NewSessionTools() error = %v", err)
	}
	ctx := &sdk.ToolExecContext{Context: agent.WithToolRun(t.Context(), agent.ToolRun{
		Platform: route.Platform, AccountID: route.AccountID, ChatID: route.ChatID,
	})}
	found, err := tools.search(ctx, sessionSearchInput{Query: "trigram"})
	if err != nil {
		t.Fatalf("search() error = %v", err)
	}
	if !strings.Contains(found, "session 1 · message 1") || !strings.Contains(found, "user: ") || strings.Contains(found, "unrelated") {
		t.Fatalf("search() = %q", found)
	}
	page, err := tools.read(ctx, sessionReadInput{Session: 1})
	if err != nil {
		t.Fatalf("read() error = %v", err)
	}
	if !strings.Contains(page, "[1 user]") || !strings.Contains(page, "[2 assistant]") {
		t.Fatalf("read() = %q", page)
	}
	if _, err := tools.search(&sdk.ToolExecContext{Context: context.Background()}, sessionSearchInput{Query: "trigram"}); err == nil {
		t.Fatal("search() without a conversation succeeded")
	}
}

func TestSessionToolsUseVectorOrder(t *testing.T) {
	store := openSessionStore(t)
	documents, err := store.ListSearchDocuments(t.Context(), conversation.Route{
		Platform: "telegram", AccountID: "bot-1", ChatID: "chat-1",
	})
	if err != nil {
		t.Fatalf("ListSearchDocuments() error = %v", err)
	}
	var assistantID string
	for _, document := range documents {
		if document.Role == "assistant" {
			assistantID = document.RecordID
		}
	}
	if assistantID == "" {
		t.Fatal("assistant document is missing")
	}
	tools, err := NewSessionTools(store, fakeSearcher{ids: []string{assistantID}})
	if err != nil {
		t.Fatalf("NewSessionTools() error = %v", err)
	}
	ctx := &sdk.ToolExecContext{Context: agent.WithToolRun(t.Context(), agent.ToolRun{
		Platform: "telegram", AccountID: "bot-1", ChatID: "chat-1",
	})}
	found, err := tools.search(ctx, sessionSearchInput{Query: "embeddings"})
	if err != nil {
		t.Fatalf("search() error = %v", err)
	}
	if !strings.Contains(found, "session 1 · message 2") || !strings.Contains(found, "assistant:") || strings.Contains(found, "user:") {
		t.Fatalf("search() = %q", found)
	}
	if !strings.Contains(tools.Tools()[0].Description, "by meaning") {
		t.Fatalf("description = %q", tools.Tools()[0].Description)
	}
}

type fakeSearcher struct {
	ids []string
}

func (f fakeSearcher) Search(context.Context, string, string, int) ([]string, bool, error) {
	return f.ids, false, nil
}

func openSessionStore(t *testing.T) *conversation.Store {
	t.Helper()
	store, err := conversation.Open(t.Context(), t.TempDir()+"/state.db")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	user, err := conversation.EncodeMessage(sdk.UserMessage("你好 sqlite trigram session search"))
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	accepted, err := store.Accept(t.Context(), conversation.AcceptInput{
		Route:           conversation.Route{Platform: "telegram", AccountID: "bot-1", ChatID: "chat-1"},
		SourceNamespace: "telegram:bot-1", SourceEventID: "update-1",
		IngressPayload: []byte(`{"update_id":1}`), Message: user,
		Run: conversation.RunSpec{Provider: "openai-responses", Model: "gpt-test", SystemPrompt: "system"},
	})
	if err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatalf("StartNextRun() error = %v", err)
	}
	_, err = store.CommitStep(t.Context(), conversation.CommitStepInput{
		RunID: accepted.RunID, Final: true,
		Step: &sdk.StepResult{
			FinishReason: sdk.FinishReasonStop,
			Messages:     []sdk.Message{sdk.AssistantMessage("vector embeddings stay optional")},
		},
		PlanOutbox: func(conversation.FinalReply) ([]conversation.OutboxChunk, error) {
			return []conversation.OutboxChunk{{Kind: "final", Payload: []byte(`{"text":"ok"}`)}}, nil
		},
	})
	if err != nil {
		t.Fatalf("CommitStep() error = %v", err)
	}
	return store
}
