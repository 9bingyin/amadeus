package schedule

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/9bingyin/amadeus/internal/gateway"
	"github.com/9bingyin/amadeus/internal/platform/local"
	"github.com/felinics/twilight/sdk"
)

func TestScheduleToolCreatesListsAndRemoves(t *testing.T) {
	service := openService(t)
	ctx := toolContext(t, "chat-1", "")
	created, err := service.Tool().Execute(ctx, map[string]any{
		"action": "create", "name": "网页监控", "when": "every 30m", "script": "post(\"changed\")",
	})
	if err != nil {
		t.Fatalf("create error = %v", err)
	}
	if !strings.Contains(created.(string), "created Schedule #1 网页监控 every 30m") {
		t.Fatalf("create = %v", created)
	}
	other, err := service.Tool().Execute(toolContext(t, "chat-2", ""), map[string]any{
		"action": "create", "name": "网页监控", "when": "30m", "script": "post(\"other\")",
	})
	if err != nil {
		t.Fatalf("create other error = %v", err)
	}
	if !strings.Contains(other.(string), "created Schedule #2") {
		t.Fatalf("create other = %v", other)
	}
	listed, err := service.Tool().Execute(ctx, map[string]any{"action": "list"})
	if err != nil {
		t.Fatalf("list error = %v", err)
	}
	if text := listed.(string); !strings.Contains(text, "Schedule #1 网页监控 · every 30m · scheduled") || strings.Contains(text, "Schedule #2") {
		t.Fatalf("list = %q", text)
	}
	if _, err := service.Tool().Execute(ctx, map[string]any{
		"action": "create", "name": "网页监控", "when": "every 1h", "script": "post(\"again\")",
	}); err != nil {
		t.Fatalf("create duplicate name error = %v", err)
	}
	if _, err := service.Tool().Execute(ctx, map[string]any{"action": "remove", "name": "网页监控"}); err == nil {
		t.Fatal("remove ambiguous error = nil")
	}
	removed, err := service.Tool().Execute(ctx, map[string]any{"action": "remove", "id": 1})
	if err != nil {
		t.Fatalf("remove error = %v", err)
	}
	if removed.(string) != "removed Schedule #1 网页监控" {
		t.Fatalf("remove = %v", removed)
	}
}

func TestCreateRejectsInvalidScript(t *testing.T) {
	service := openService(t)
	_, err := service.Tool().Execute(toolContext(t, "chat", ""), map[string]any{
		"action": "create", "name": "检查", "when": "30m",
		"script": `const out = await agent("look"); post(String(out));`,
	})
	if err == nil || !strings.Contains(err.Error(), "Line 1:19") {
		t.Fatalf("create error = %v", err)
	}
	listed, err := service.Tool().Execute(toolContext(t, "chat", ""), map[string]any{"action": "list"})
	if err != nil {
		t.Fatalf("list error = %v", err)
	}
	if listed.(string) != "no scheduled tasks" {
		t.Fatalf("list = %q", listed)
	}
}

func TestEditReplacesScript(t *testing.T) {
	service := openService(t)
	ctx := toolContext(t, "chat", "")
	if _, err := service.Tool().Execute(ctx, map[string]any{
		"action": "create", "name": "检查", "when": "30m", "script": `post("old")`,
	}); err != nil {
		t.Fatalf("create error = %v", err)
	}
	updated, err := service.Tool().Execute(ctx, map[string]any{
		"action": "edit", "id": 1, "script": `post("new")`,
	})
	if err != nil {
		t.Fatalf("edit error = %v", err)
	}
	if updated.(string) != "updated Schedule #1 检查" {
		t.Fatalf("edit = %v", updated)
	}
	script, err := os.ReadFile(filepath.Join(service.directory, "1", "task.js"))
	if err != nil {
		t.Fatalf("read script: %v", err)
	}
	if string(script) != `post("new")` {
		t.Fatalf("script = %q", script)
	}
	if _, err := service.Tool().Execute(ctx, map[string]any{
		"action": "edit", "id": 1, "script": `const out = await agent("look");`,
	}); err == nil {
		t.Fatal("edit invalid script error = nil")
	}
	script, err = os.ReadFile(filepath.Join(service.directory, "1", "task.js"))
	if err != nil {
		t.Fatalf("read script: %v", err)
	}
	if string(script) != `post("new")` {
		t.Fatalf("script after rejected edit = %q", script)
	}
	if claimed := mustClaim(t, service); claimed.ID != 1 {
		t.Fatalf("claim = %#v", claimed)
	}
	if _, err := service.Tool().Execute(ctx, map[string]any{
		"action": "edit", "id": 1, "script": `post("later")`,
	}); err == nil || err.Error() != "task is running" {
		t.Fatalf("edit running error = %v", err)
	}
}

func TestActiveTextSkipsCompleted(t *testing.T) {
	service := openService(t)
	owner := route{Platform: "telegram", AccountID: "123", ChatID: "100"}
	if _, err := service.create(t.Context(), owner, "还在", "every 30m", `post("a")`); err != nil {
		t.Fatalf("create active error = %v", err)
	}
	if _, err := service.create(t.Context(), owner, "结束", "30m", `post("b")`); err != nil {
		t.Fatalf("create completed error = %v", err)
	}
	if _, err := service.db.Exec(`UPDATE jobs SET state = 'completed' WHERE id = 2`); err != nil {
		t.Fatalf("complete job: %v", err)
	}
	text, err := service.ActiveText(t.Context(), "telegram", "123", "100", "")
	if err != nil {
		t.Fatalf("ActiveText() error = %v", err)
	}
	if !strings.Contains(text, "Schedule #1 还在 · every 30m · 下次 ") || strings.Contains(text, "结束") {
		t.Fatalf("ActiveText() = %q", text)
	}
	empty, err := service.ActiveText(t.Context(), "telegram", "123", "other", "")
	if err != nil {
		t.Fatalf("ActiveText() other error = %v", err)
	}
	if empty != "没有未完成的定时任务。" {
		t.Fatalf("ActiveText() other = %q", empty)
	}
}

func TestRunNotifiesOnceAndCompletes(t *testing.T) {
	service := openService(t)
	owner := route{Platform: "telegram", AccountID: "bot", ChatID: "chat", ThreadID: ""}
	if _, err := service.create(t.Context(), owner, "提醒", "1s", `post("该开会了")`); err != nil {
		t.Fatalf("create error = %v", err)
	}
	if _, err := service.db.Exec(`UPDATE jobs SET next_run_at_ms = 0 WHERE id = 1`); err != nil {
		t.Fatalf("make job due: %v", err)
	}
	received := make(chan agent.Message, 1)
	service.Use(Runner{Platform: mustPlatform(t, func(_ context.Context, message agent.Message) (*gateway.Receipt, error) {
		received <- message
		return &gateway.Receipt{}, nil
	})})
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		service.Run(ctx)
	}()
	var got agent.Message
	select {
	case got = <-received:
	case <-time.After(2 * time.Second):
		cancel()
		<-done
		t.Fatal("timed out waiting for notification")
	}
	cancel()
	<-done
	if !strings.Contains(got.Text, "[Schedule #1 提醒 once ") || !strings.HasSuffix(got.Text, "\n该开会了") {
		t.Fatalf("notice = %q", got.Text)
	}
	if got.ConversationID != "chat" || got.SenderID != "Schedule #1 提醒" || got.SourceNamespace != "local" {
		t.Fatalf("message = %#v", got)
	}
	item, err := service.jobByID(t.Context(), owner, 1)
	if err != nil {
		t.Fatalf("jobByID() error = %v", err)
	}
	if item.State != "completed" || item.Status != "ok" {
		t.Fatalf("job = %#v", item)
	}
}

func TestRunSilentReadAndAgent(t *testing.T) {
	service := openService(t)
	owner := route{Platform: "telegram", AccountID: "bot", ChatID: "chat"}
	script := `
write("snapshot.txt", "one")
if (read("snapshot.txt") !== "one") { throw new Error("snapshot") }
const seen = agent("look")
if (seen !== "seen") { throw new Error(seen) }
`
	if _, err := service.create(t.Context(), owner, "检查", "30m", script); err != nil {
		t.Fatalf("create error = %v", err)
	}
	if _, err := service.db.Exec(`UPDATE jobs SET kind = 'once' WHERE id = 1`); err != nil {
		t.Fatalf("mark job once: %v", err)
	}
	service.Use(Runner{
		Platform: mustPlatform(t, func(context.Context, agent.Message) (*gateway.Receipt, error) {
			t.Fatal("silent run posted")
			return nil, nil
		}),
		Agent: func(_ context.Context, directory, prompt string, _ func(string) error) (string, error) {
			if prompt != "look" || !strings.HasSuffix(directory, "/1") {
				t.Fatalf("agent prompt = %q directory = %q", prompt, directory)
			}
			return "seen", nil
		},
	})
	service.execute(t.Context(), mustClaim(t, service))
	item, err := service.jobByID(t.Context(), owner, 1)
	if err != nil {
		t.Fatalf("jobByID() error = %v", err)
	}
	if item.State != "completed" || item.Status != "silent" {
		t.Fatalf("job = %#v", item)
	}
}

func TestRunErrorRetries(t *testing.T) {
	service := openService(t)
	owner := route{Platform: "telegram", AccountID: "bot", ChatID: "chat"}
	if _, err := service.create(t.Context(), owner, "坏了", "30m", `read("../secret")`); err != nil {
		t.Fatalf("create error = %v", err)
	}
	before := time.Now()
	service.execute(t.Context(), mustClaim(t, service))
	item, err := service.jobByID(t.Context(), owner, 1)
	if err != nil {
		t.Fatalf("jobByID() error = %v", err)
	}
	if item.State != "scheduled" || item.Status != "error" || !item.Next.After(before.Add(30*time.Second)) {
		t.Fatalf("job = %#v", item)
	}
}

func openService(t *testing.T) *Service {
	t.Helper()
	store, err := conversation.Open(t.Context(), filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := Open(store.DB(), t.TempDir())
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	return service
}

func toolContext(t *testing.T, chatID, threadID string) *sdk.ToolExecContext {
	t.Helper()
	return &sdk.ToolExecContext{Context: agent.WithToolRun(t.Context(), agent.ToolRun{
		Platform: "telegram", AccountID: "bot", ChatID: chatID, ThreadID: threadID,
	})}
}

func mustPlatform(t *testing.T, submit func(context.Context, agent.Message) (*gateway.Receipt, error)) *local.Platform {
	t.Helper()
	platform, err := local.New(submitterFunc(submit))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return platform
}

type submitterFunc func(context.Context, agent.Message) (*gateway.Receipt, error)

func (f submitterFunc) Submit(ctx context.Context, message agent.Message) (*gateway.Receipt, error) {
	return f(ctx, message)
}

func mustClaim(t *testing.T, service *Service) job {
	t.Helper()
	if _, err := service.db.Exec(`UPDATE jobs SET next_run_at_ms = 0`); err != nil {
		t.Fatalf("make jobs due: %v", err)
	}
	item, ok, err := service.claim(t.Context(), time.Now())
	if err != nil || !ok {
		t.Fatalf("claim() = %v, %v, %v", item, ok, err)
	}
	return item
}
