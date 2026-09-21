package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/config"
	"github.com/9bingyin/amadeus/internal/gateway"
	"github.com/felinics/twilight/sdk"
)

func TestFinishRunLogsOneJSONError(t *testing.T) {
	var output bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	if finishRun(t.Context(), time.Now(), errors.New("raw failure")) {
		t.Fatal("finishRun() reported success")
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("log lines = %d, output = %q", len(lines), output.String())
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatalf("decode log: %v\noutput: %s", err, output.String())
	}
	if record["msg"] != "Amadeus stopped" || record["err"] != "raw failure" {
		t.Fatalf("record = %#v", record)
	}
}

func TestRunRejectsArguments(t *testing.T) {
	err := runIsolated(t, []string{"telegram"})
	if err == nil || err.Error() != "usage: amadeus" {
		t.Fatalf("run() error = %v", err)
	}
}

func TestRunReadsConfigFromAmadeusHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AMADEUS_HOME", home)
	writeHomeConfig(t, home, `{
		"openai":{"apiKey":"key","model":"model"}
	}`)

	err := runIsolated(t, nil)
	if err == nil || !strings.Contains(err.Error(), "at least one message platform must be enabled") {
		t.Fatalf("run() error = %v", err)
	}
}

func TestRunRequiresTelegramCredentialsWhenEnabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AMADEUS_HOME", home)
	writeHomeConfig(t, home, `{
		"openai":{"apiKey":"key","model":"model"},
		"telegram":{"enabled":true},
		"mcp":{"servers":[{"name":"legacy","transport":"sse","url":"https://example.com"}]}
	}`)

	err := runIsolated(t, nil)
	if err == nil || !strings.Contains(err.Error(), "telegram bot token is required") {
		t.Fatalf("run() error = %v", err)
	}
}

func TestRunRejectsInvalidMCPConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AMADEUS_HOME", home)
	writeHomeConfig(t, home, `{
		"openai":{"apiKey":"key","model":"model"},
		"telegram":{"enabled":true,"botToken":"123:token","allowedUserIDs":[42]},
		"mcp":{"servers":[{"name":"legacy","transport":"sse","url":"https://example.com"}]}
	}`)

	err := runIsolated(t, nil)
	if err == nil || !strings.Contains(err.Error(), `unsupported transport "sse"`) {
		t.Fatalf("run() error = %v", err)
	}
}

func TestAgentRuntimeUsesWorkspaceAndGlobalSkills(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var body struct {
			Instructions string `json:"instructions"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		for _, want := range []string{
			"You are a personal assistant.",
			"<tools>",
			"<rules>",
			"<system>",
			"<cwd>",
			"<name>test-skill</name>",
			"<description>Use for integration tests.</description>",
			"/.amadeus/skills/test-skill/SKILL.md</location>",
		} {
			if !strings.Contains(body.Instructions, want) {
				t.Errorf("instructions = %q, want containing %q", body.Instructions, want)
			}
		}
		if strings.Contains(body.Instructions, "<telegram>") {
			t.Error("instructions contain telegram section while Telegram is disabled")
		}
		if strings.Contains(body.Instructions, "SKILL_BODY_MUST_BE_LOADED_ON_DEMAND") {
			t.Error("instructions contain skill body")
		}
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write([]byte(`{
			"id":"response-1","created_at":1700000000,"model":"test-model",
			"output":[{"type":"message","id":"message-1","role":"assistant",
			"content":[{"type":"output_text","text":"done","annotations":[]}]}]
		}`)); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	homeParent := t.TempDir()
	home := filepath.Join(homeParent, ".amadeus")
	t.Setenv("AMADEUS_HOME", home)
	skillDirectory := filepath.Join(home, "skills", "test-skill")
	if err := os.MkdirAll(skillDirectory, 0o700); err != nil {
		t.Fatalf("create skill directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDirectory, "SKILL.md"), []byte(`---
name: test-skill
description: Use for integration tests.
---
SKILL_BODY_MUST_BE_LOADED_ON_DEMAND
`), 0o600); err != nil {
		t.Fatalf("write skill: %v", err)
	}

	runtime, err := newAgentRuntime(t.Context(), config.Config{OpenAI: config.OpenAI{
		APIKey: "key", Model: "test-model", BaseURL: server.URL,
	}})
	if err != nil {
		t.Fatalf("newAgentRuntime() error = %v", err)
	}
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})

	workspace := filepath.Join(home, "workspace")
	info, err := os.Stat(workspace)
	if err != nil {
		t.Fatalf("stat workspace: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("workspace %q is not a directory", workspace)
	}
	availableTools := runtime.toolSet.Tools()
	var bashTool *sdk.Tool
	for index := range availableTools {
		if availableTools[index].Name == "bash" {
			bashTool = &availableTools[index]
			break
		}
	}
	if bashTool == nil {
		t.Fatal("bash tool not found")
	}
	output, err := bashTool.Execute(&sdk.ToolExecContext{Context: t.Context()}, map[string]any{"command": "pwd"})
	if err != nil {
		t.Fatalf("execute bash tool: %v", err)
	}
	outputText, ok := output.(string)
	if !ok || strings.TrimSpace(outputText) != workspace {
		t.Fatalf("bash cwd = %q, want %q", output, workspace)
	}

	reply, err := runtime.gateway.Handle(t.Context(), gateway.Message{
		Platform: "test", ConversationID: "chat", SenderID: "user", Text: "hello",
	})
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if reply != "done" {
		t.Fatalf("reply = %q, want done", reply)
	}
}

func runIsolated(t *testing.T, args []string) error {
	t.Helper()
	previousLogger := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	return run(t.Context(), args)
}

func writeHomeConfig(t *testing.T, home, content string) {
	t.Helper()
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatalf("create home: %v", err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(content), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
}
