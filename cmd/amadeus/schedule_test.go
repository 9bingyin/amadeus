package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/config"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/9bingyin/amadeus/internal/memory"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
)

func TestScheduledAgentInheritsRuntimeToolsPromptAndRequestScope(t *testing.T) {
	done := make(chan struct{})
	var conversationID, sessionID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		defer close(done)
		var body struct {
			Instructions string `json:"instructions"`
			Tools        []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		for _, want := range []string{"You are running a scheduled task.", "runtime scheduled fact"} {
			if !strings.Contains(body.Instructions, want) {
				t.Errorf("scheduled prompt missing %q: %s", want, body.Instructions)
			}
		}
		var names []string
		for _, tool := range body.Tools {
			names = append(names, tool.Name)
		}
		for _, name := range []string{"bash", "read", "write", "edit", "session_search", "session_read", "memory", "schedule", "codemode", "post"} {
			if !slices.Contains(names, name) {
				t.Errorf("scheduled runtime tools missing %q: %v", name, names)
			}
		}
		if request.Header.Get("X-Session") != sessionID || request.Header.Get("X-Conversation") != conversationID {
			t.Errorf("scheduled headers = %v, want session=%s conversation=%s", request.Header, sessionID, conversationID)
		}
		w.Header().Set("Content-Type", "application/json")
		if _, err := io.WriteString(w, `{"id":"response-1","created_at":1700000000,"model":"test-model","output":[{"type":"message","id":"message-1","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}]}`); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer server.Close()
	home := t.TempDir()
	t.Setenv("AMADEUS_HOME", home)
	settings := config.Config{
		Workspace: t.TempDir(), Model: "assistant", Search: config.Search{Engine: config.SearchEngineFTS5},
		Models: map[string]config.Model{"assistant": {Provider: "gateway", ID: "test-model"}},
		Providers: map[string]config.Provider{"gateway": {
			API: config.APIOpenAIResponses, APIKey: "test", BaseURL: server.URL,
			Headers: map[string]string{"X-Session": "{session}", "X-Conversation": "{conversation}"},
		}},
	}
	runtime, err := newAgentRuntime(t.Context(), settings)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	owner := conversation.Route{Platform: "telegram", AccountID: "bot", ChatID: "100", ThreadID: "3"}
	conversationID, sessionID, err = runtime.store.EnsureConversation(t.Context(), owner)
	if err != nil {
		t.Fatal(err)
	}
	memories, err := memory.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := memories.Apply("memory", "add", "runtime scheduled fact", ""); err != nil {
		t.Fatal(err)
	}
	ctx := &toolkit.Context{Context: agent.WithToolRun(t.Context(), agent.ToolRun{
		Platform: owner.Platform, AccountID: owner.AccountID, ChatID: owner.ChatID, ThreadID: owner.ThreadID,
	})}
	_, err = runtime.jobs.Tool().Execute(ctx, map[string]any{
		"action": "create", "name": "检查", "when": "1ms", "script": `await tools.agent({prompt:"look"});`,
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("scheduled agent did not call provider; state=%s", filepath.Join(home, "state.db"))
	}
}
