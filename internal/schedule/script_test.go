package schedule

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
)

func scriptRoot(t *testing.T) *os.Root {
	t.Helper()
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return root
}

func TestScriptUsesAsyncScopedTools(t *testing.T) {
	root := scriptRoot(t)
	var posts []string
	err := runScript(t.Context(), `
await tools.write({path:"state/snapshot.txt", content:"one"});
if (await tools.read({path:"state/snapshot.txt"}) !== "one") throw new Error("snapshot");
if (await tools.read({path:"missing"}) !== "") throw new Error("missing file");
const reply = await tools.agent({prompt:"look"});
await tools.post({text:reply});
if ("bash" in tools || "session_read" in tools || typeof agent !== "undefined") throw new Error("chat capability leaked");
`, scriptHost{
		root: root,
		agent: func(_ context.Context, prompt string) (string, error) {
			if prompt != "look" {
				return "", errors.New("wrong prompt")
			}
			return "seen", nil
		},
		post: func(text string) error { posts = append(posts, text); return nil },
	})
	if err != nil || len(posts) != 1 || posts[0] != "seen" {
		t.Fatalf("runScript = %v; posts = %v", err, posts)
	}
}

func TestScriptCannotEscapeTaskRoot(t *testing.T) {
	root := scriptRoot(t)
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := root.Symlink(outside, "link"); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{
		`await tools.read({path:"../secret"});`,
		`await tools.write({path:"../secret", content:"changed"});`,
		`await tools.read({path:"/etc/passwd"});`,
		`await tools.read({path:"link"});`,
		`await tools.write({path:"link", content:"changed"});`,
	} {
		if err := runScript(t.Context(), source, scriptHost{root: root}); err == nil {
			t.Fatalf("runScript(%q) escaped root", source)
		}
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "outside" {
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
`, scriptHost{root: scriptRoot(t), mcp: []toolkit.Tool{remote}})
	if err != nil {
		t.Fatal(err)
	}
	if err := runScript(t.Context(), `await tools.other__lookup({});`, scriptHost{root: scriptRoot(t), mcp: []toolkit.Tool{remote}}); err == nil {
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

func TestScriptValidationIsAsyncAndNonExecuting(t *testing.T) {
	if err := checkScript(t.Context(), `await tools.agent({prompt:"look"}); while (true) {};`); err != nil {
		t.Fatal(err)
	}
	if err := checkScript(t.Context(), `const = 1;`); err == nil || !strings.Contains(err.Error(), "SyntaxError") {
		t.Fatalf("invalid script error = %v", err)
	}
}
