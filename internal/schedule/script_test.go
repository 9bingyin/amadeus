package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/tools"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
)

func scriptTools(t *testing.T) (string, []toolkit.Tool) {
	t.Helper()
	t.Setenv("AMADEUS_HOME", t.TempDir())
	workspace := t.TempDir()
	bindings, err := tools.New(workspace)
	if err != nil {
		t.Fatal(err)
	}
	return workspace, bindings
}

func TestScriptUsesMainTools(t *testing.T) {
	workspace, bindings := scriptTools(t)
	var calls []string
	for _, name := range []string{"session_search", "session_read", "send_file", "schedule", "memory"} {
		bindings = append(bindings, toolkit.New(name, "Shared main tool", func(call *toolkit.Context, _ struct{}) (any, error) {
			run, ok := agent.ToolRunFrom(call.Context)
			if !ok || run.ChatID != "100" || run.ThreadID != "3" {
				return nil, errors.New("missing creator route")
			}
			calls = append(calls, name)
			return "ok", nil
		}))
	}
	var posts []string
	ctx := agent.WithToolRun(t.Context(), agent.ToolRun{Platform: "telegram", AccountID: "bot", ChatID: "100", ThreadID: "3"})
	source := fmt.Sprintf(`
const expected = ["read", "edit", "bash", "write", "session_search", "session_read", "send_file", "schedule", "memory", "agent", "post"];
const names = ALL_TOOLS.map(tool => tool.name);
if (expected.length !== names.length || expected.some(name => !names.includes(name))) throw new Error("missing main tools");
await tools.write({path:"state/snapshot.txt", content:"one"});
if (await tools.read({path:"state/snapshot.txt"}) !== "one") throw new Error("snapshot");
await tools.edit({path:"state/snapshot.txt", edits:[{oldText:"one", newText:"two"}]});
if (await tools.read({path:"state/snapshot.txt"}) !== "two") throw new Error("edit");
if (!(await tools.bash({command:"pwd"})).output.includes(%q)) throw new Error("workspace");
let missing = false;
try { await tools.read({path:"missing"}); } catch (error) { missing = true; }
if (!missing) throw new Error("read must match main tool errors");
for (const name of ["session_search", "session_read", "send_file", "schedule", "memory"]) await tools[name]({});
const reply = await tools.agent({prompt:"look"});
await tools.post({text:reply});
if (typeof agent !== "undefined") throw new Error("ambient agent");
`, workspace)
	err := runScript(ctx, source, scriptHost{
		tools: bindings,
		agent: func(callCtx context.Context, prompt string) (string, error) {
			run, ok := agent.ToolRunFrom(callCtx)
			if prompt != "look" || !ok || run.ChatID != "100" {
				return "", errors.New("wrong prompt or route")
			}
			return "seen", nil
		},
		post: func(text string) error { posts = append(posts, text); return nil },
	})
	if err != nil || !slices.Equal(posts, []string{"seen"}) {
		t.Fatalf("runScript = %v; posts = %v", err, posts)
	}
	if !slices.Equal(calls, []string{"session_search", "session_read", "send_file", "schedule", "memory"}) {
		t.Fatalf("main tool calls = %v", calls)
	}
}

func TestScriptCanAccessPathsOutsideWorkspace(t *testing.T) {
	workspace, bindings := scriptTools(t)
	outside := filepath.Join(t.TempDir(), "shared.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "link")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../outside.txt", outside, "link"} {
		t.Run(path, func(t *testing.T) {
			source := fmt.Sprintf(`
await tools.write({path:%q, content:"one"});
await tools.edit({path:%q, edits:[{oldText:"one", newText:"two"}]});
if (await tools.read({path:%q}) !== "two") throw new Error("outside file");
`, path, path, path)
			if err := runScript(t.Context(), source, scriptHost{tools: bindings}); err != nil {
				t.Fatal(err)
			}
		})
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "two" {
		t.Fatalf("outside file = %q, %v", data, err)
	}
}

func TestScriptCanDiscoverAndCallOnlyInjectedMCP(t *testing.T) {
	remote := toolkit.New("web__lookup", "Look up pages", func(*toolkit.Context, struct{}) (any, error) {
		return map[string]any{"content": []any{}, "structuredContent": map[string]any{"answer": "found"}}, nil
	})
	remote.Namespace = "web"
	err := runScript(t.Context(), `
const matches = await searchTools("pages pages", {namespace:"web"});
if (matches.length !== 1 || matches[0].name !== "web__lookup") throw new Error("discovery");
if ((await tools.web__lookup({})).structuredContent.answer !== "found") throw new Error("result");
`, scriptHost{tools: []toolkit.Tool{remote}})
	if err != nil {
		t.Fatal(err)
	}
	if err := runScript(t.Context(), `await tools.other__lookup({});`, scriptHost{tools: []toolkit.Tool{remote}}); err == nil {
		t.Fatal("unregistered MCP tool was callable")
	}
}

func TestScriptCancellationReachesAgent(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runScript(ctx, `await tools.agent({prompt:"wait"});`, scriptHost{
			agent: func(callCtx context.Context, _ string) (string, error) {
				close(started)
				<-callCtx.Done()
				return "", callCtx.Err()
			},
		})
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("script did not stop")
	}
}

func TestScriptCancellationReachesBash(t *testing.T) {
	workspace, bindings := scriptTools(t)
	started := make(chan struct{})
	for index := range bindings {
		if bindings[index].Name == "bash" {
			execute := bindings[index].Execute
			bindings[index].Execute = func(call *toolkit.Context, input any) (any, error) {
				close(started)
				return execute(call, input)
			}
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- runScript(ctx, `await tools.bash({command:"sleep 30"});`, scriptHost{tools: bindings})
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatalf("bash did not start in %s", workspace)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("bash did not stop")
	}
}

func TestScriptValidationIsAsyncAndNonExecuting(t *testing.T) {
	if err := checkScript(t.Context(), `await tools.agent({prompt:"look"}); while (true) {};`); err != nil {
		t.Fatal(err)
	}
	if err := checkScript(t.Context(), `const = 1;`); err == nil || !strings.Contains(err.Error(), "SyntaxError") {
		t.Fatalf("invalid script error = %v", err)
	}
}

func TestScriptSharedToolsAreNotModified(t *testing.T) {
	_, bindings := scriptTools(t)
	before, err := json.Marshal(bindings)
	if err != nil {
		t.Fatal(err)
	}
	if err := runScript(t.Context(), `return ALL_TOOLS.length;`, scriptHost{tools: bindings}); err != nil {
		t.Fatal(err)
	}
	after, err := json.Marshal(bindings)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("script mutated the shared tool definitions")
	}
}
