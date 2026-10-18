package schedule

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/9bingyin/amadeus/internal/memory"
	"github.com/9bingyin/amadeus/internal/platform/telegram"
	"github.com/9bingyin/amadeus/internal/tools"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	"github.com/felinics/twilight/sdk"
	bot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

func TestRunAgentReusesMainToolsPromptAndRoute(t *testing.T) {
	workspace, bindings := scriptTools(t)
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	owner := conversation.Route{Platform: "telegram", AccountID: "bot", ChatID: "100", ThreadID: "3"}
	seedTaskConversation(t, store, owner)
	sessions, err := tools.NewSessionTools(store, nil)
	if err != nil {
		t.Fatal(err)
	}
	bindings = append(bindings, sessions.Tools()...)
	memories, err := memory.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bindings = append(bindings, memories.Tool())
	jobs, err := Open(store.DB(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bindings = append(bindings, jobs.Tool())
	files, err := telegram.NewSendFiles(workspace)
	if err != nil {
		t.Fatal(err)
	}
	sender := &taskFileSender{}
	files.Bind(sender)
	bindings = append(bindings, files.Tool())
	remote := toolkit.New("scope__check", "Check inherited context", func(call *toolkit.Context, _ struct{}) (any, error) {
		run, ok := agent.ToolRunFrom(call.Context)
		if !ok || run.Platform != owner.Platform || run.AccountID != owner.AccountID || run.ChatID != owner.ChatID || run.ThreadID != owner.ThreadID || !call.Nested {
			return nil, fmt.Errorf("wrong task scope: %#v", run)
		}
		return "found", nil
	})
	remote.Namespace = "scope"
	bindings = append(bindings, remote)

	parentPrompt := agent.BuildSystemPrompt(workspace, true, "test skill", "test soul", "global rules", "project rules", "test user", "test memory")
	var calls atomic.Int32
	var mainNames []string
	source := fmt.Sprintf(`
if (!(await tools.bash({command:"pwd"})).includes(%q)) throw new Error("wrong workspace");
await tools.write({path:"snapshot.txt", content:"one"});
await tools.edit({path:"snapshot.txt", edits:[{oldText:"one", newText:"two"}]});
if (await tools.read({path:"snapshot.txt"}) !== "two") throw new Error("files");
if (!(await tools.session_search({query:"saved marker"})).includes("saved marker")) throw new Error("session search");
if (!(await tools.session_read({session:1})).includes("saved marker")) throw new Error("session read");
await tools.memory({action:"add", target:"memory", content:"scheduled fact"});
if (await tools.schedule({action:"list"}) !== "no scheduled tasks") throw new Error("schedule route");
await tools.send_file({path:"snapshot.txt", kind:"document"});
if (await tools.scope__check({}) !== "found") throw new Error("remote scope");
await tools.post({text:"task report"});
return "verified";
`, workspace)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var body struct {
			Instructions string `json:"instructions"`
			Tools        []struct {
				Name string `json:"name"`
			} `json:"tools"`
			Input json.RawMessage `json:"input"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var names []string
		for _, tool := range body.Tools {
			names = append(names, tool.Name)
		}
		call := calls.Add(1)
		if call == 1 {
			mainNames = names
		} else {
			if !strings.HasPrefix(body.Instructions, parentPrompt) || !strings.Contains(body.Instructions, "You are running a scheduled task.") {
				t.Errorf("scheduled prompt does not inherit main prompt: %s", body.Instructions)
			}
			for _, name := range mainNames {
				if !slices.Contains(names, name) {
					t.Errorf("scheduled agent missing main tool %q", name)
				}
			}
			if len(names) != len(mainNames)+1 || !slices.Contains(names, "post") || slices.Contains(names, "scope__check") {
				t.Errorf("scheduled declarations = %v, main = %v", names, mainNames)
			}
			if request.Header.Get("X-Session") != "task-session" || request.Header.Get("X-Conversation") != "chat-conversation" {
				t.Errorf("request scope headers = %v", request.Header)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if call == 2 {
			arguments, err := json.Marshal(map[string]string{"code": source})
			if err != nil {
				t.Errorf("encode script: %v", err)
				return
			}
			if err := json.NewEncoder(w).Encode(map[string]any{
				"id": "response-2", "created_at": 1700000000, "model": "test-model",
				"output": []any{map[string]any{"type": "function_call", "id": "fc-1", "call_id": "code-1", "name": "codemode", "arguments": string(arguments)}},
			}); err != nil {
				t.Errorf("encode response: %v", err)
			}
			return
		}
		if call == 3 {
			var items []struct {
				Type   string `json:"type"`
				Output string `json:"output"`
			}
			if err := json.Unmarshal(body.Input, &items); err != nil {
				t.Errorf("decode tool result: %v", err)
			}
			found := false
			for _, item := range items {
				if item.Type == "function_call_output" {
					found = strings.Contains(item.Output, "Script completed") && strings.Contains(item.Output, "verified")
					if !found {
						t.Errorf("scheduled script result = %s", item.Output)
					}
				}
			}
			if !found {
				t.Error("missing successful script result")
			}
		}
		if _, err := io.WriteString(w, `{"id":"response-final","created_at":1700000000,"model":"test-model","output":[{"type":"message","id":"message-final","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}]}`); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer server.Close()
	config := agent.Config{APIKey: "test", Model: "test-model", BaseURL: server.URL, SystemPrompt: parentPrompt}
	main, err := agent.New(config, bindings)
	if err != nil {
		t.Fatal(err)
	}
	if reply, err := main.Run(t.Context(), agent.Message{Text: "main"}); err != nil || reply != "done" {
		t.Fatalf("main Run = %q, %v", reply, err)
	}
	config.Headers = map[string]string{"X-Session": "{session}", "X-Conversation": "{conversation}"}
	ctx := agent.WithToolRun(t.Context(), agent.ToolRun{Platform: owner.Platform, AccountID: owner.AccountID, ChatID: owner.ChatID, ThreadID: owner.ThreadID})
	ctx = agent.WithRequestScope(ctx, agent.RequestScope{SessionID: "task-session", ConversationID: "chat-conversation"})
	var posts []string
	reply, err := RunAgent(ctx, AgentRequest{
		Config: config, Directory: t.TempDir(), Prompt: "scheduled", Tools: bindings,
		Post: func(text string) error { posts = append(posts, text); return nil },
	})
	if err != nil || reply != "done" || calls.Load() != 3 {
		t.Fatalf("scheduled RunAgent = %q, %v; calls = %d", reply, err, calls.Load())
	}
	if !slices.Equal(posts, []string{"task report"}) {
		t.Fatalf("posts = %v", posts)
	}
	if sender.documents != 1 || sender.chatID != int64(100) || sender.threadID != 3 || sender.content != "two" {
		t.Fatalf("scheduled send_file = %#v", sender)
	}
	_, facts, err := memories.Load()
	if err != nil || !strings.Contains(facts, "scheduled fact") {
		t.Fatalf("shared memory = %q, %v", facts, err)
	}
	data, err := os.ReadFile(filepath.Join(workspace, "snapshot.txt"))
	if err != nil || string(data) != "two" {
		t.Fatalf("shared workspace = %q, %v", data, err)
	}
}

func seedTaskConversation(t *testing.T, store *conversation.Store, owner conversation.Route) {
	t.Helper()
	message, err := conversation.EncodeMessage(sdk.UserMessage("saved marker"))
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := store.Accept(t.Context(), conversation.AcceptInput{
		Route: owner, SourceNamespace: "telegram:bot", SourceEventID: "seed-1", IngressPayload: []byte(`{}`), Message: message,
		Run: conversation.RunSpec{Provider: "openai-responses", Model: "test-model", SystemPrompt: "system"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartNextRun(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CommitStep(t.Context(), conversation.CommitStepInput{
		RunID: accepted.RunID, Final: true,
		Step: &toolkit.Step{FinishReason: sdk.FinishReasonStop, Messages: []sdk.Message{sdk.AssistantMessage("saved answer")}},
		PlanReply: func(conversation.FinalReply) ([]conversation.ReplyChunk, error) {
			return []conversation.ReplyChunk{{Kind: "final", Payload: []byte(`{"text":"saved answer"}`)}}, nil
		},
	}); err != nil {
		t.Fatal(err)
	}
}

type taskFileSender struct {
	documents int
	chatID    any
	threadID  int
	content   string
}

func (s *taskFileSender) SendPhoto(context.Context, *bot.SendPhotoParams) (*models.Message, error) {
	return nil, fmt.Errorf("unexpected photo")
}

func (s *taskFileSender) SendDocument(_ context.Context, params *bot.SendDocumentParams) (*models.Message, error) {
	data, err := io.ReadAll(params.Document.(*models.InputFileUpload).Data)
	if err != nil {
		return nil, err
	}
	s.documents++
	s.chatID, s.threadID, s.content = params.ChatID, params.MessageThreadID, string(data)
	return &models.Message{ID: 1}, nil
}
