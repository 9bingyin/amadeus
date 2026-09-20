package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	path := writeConfig(t, `{
		"workspace": "custom-workspace",
		"logging": {"level": "DEBUG", "format": "JSON", "addSource": true},
		"openai": {
			"apiKey": "json-key",
			"model": "gpt-5-mini",
			"baseURL": "https://api.example.com/v1",
			"reasoningEffort": "medium"
		},
		"telegram": {
			"enabled": true,
			"botToken": "telegram-token",
			"allowedUserIDs": [123, 456]
		},
		"mcp": {
			"servers": [
				{
					"name": "remote",
					"transport": "http",
					"url": "https://mcp.example.com",
					"headers": {"Authorization": "Bearer ${MCP_TOKEN}"}
				},
				{
					"name": "local",
					"transport": "stdio",
					"command": "mcp-server",
					"args": ["--stdio"],
					"env": {"MODE": "test"}
				}
			]
		}
	}`)

	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.Workspace != "custom-workspace" {
		t.Fatalf("workspace = %q, want %q", config.Workspace, "custom-workspace")
	}
	if config.Logging.Level != "debug" || config.Logging.Format != "json" || !config.Logging.AddSource {
		t.Fatalf("logging = %#v", config.Logging)
	}
	if config.OpenAI.APIKey != "json-key" {
		t.Fatalf("apiKey = %q, want %q", config.OpenAI.APIKey, "json-key")
	}
	if config.OpenAI.Model != "gpt-5-mini" {
		t.Fatalf("model = %q, want %q", config.OpenAI.Model, "gpt-5-mini")
	}
	if config.OpenAI.BaseURL != "https://api.example.com/v1" {
		t.Fatalf("baseURL = %q, want %q", config.OpenAI.BaseURL, "https://api.example.com/v1")
	}
	if config.OpenAI.ReasoningEffort != "medium" {
		t.Fatalf("reasoningEffort = %q, want %q", config.OpenAI.ReasoningEffort, "medium")
	}
	if config.Telegram.BotToken != "telegram-token" {
		t.Fatalf("botToken = %q, want %q", config.Telegram.BotToken, "telegram-token")
	}
	if len(config.Telegram.AllowedUserIDs) != 2 || config.Telegram.AllowedUserIDs[0] != 123 || config.Telegram.AllowedUserIDs[1] != 456 {
		t.Fatalf("allowedUserIDs = %v, want [123 456]", config.Telegram.AllowedUserIDs)
	}
	if len(config.MCP.Servers) != 2 {
		t.Fatalf("MCP servers = %d, want 2", len(config.MCP.Servers))
	}
	if config.MCP.Servers[0].Headers["Authorization"] != "Bearer ${MCP_TOKEN}" {
		t.Fatalf("MCP header = %q", config.MCP.Servers[0].Headers["Authorization"])
	}
	if config.MCP.Servers[1].Command != "mcp-server" || len(config.MCP.Servers[1].Args) != 1 {
		t.Fatalf("stdio MCP server = %#v", config.MCP.Servers[1])
	}
}

func TestLoadIgnoresLegacyEnvironmentOverrides(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "env-key")
	t.Setenv("OPENAI_MODEL", "gpt-5")
	t.Setenv("OPENAI_BASE_URL", "https://env.example.com/v1")
	t.Setenv("OPENAI_REASONING_EFFORT", "high")
	t.Setenv("TELEGRAM_BOT_TOKEN", "env-telegram-token")
	t.Setenv("TELEGRAM_ALLOWED_USER_IDS", "789, 101112")
	path := writeConfig(t, `{
		"openai": {
			"apiKey": "json-key",
			"model": "gpt-5-mini",
			"baseURL": "https://api.example.com/v1",
			"reasoningEffort": "medium"
		},
		"telegram": {
			"enabled": true,
			"botToken": "json-telegram-token",
			"allowedUserIDs": [123]
		}
	}`)

	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.OpenAI.APIKey != "json-key" {
		t.Fatalf("apiKey = %q, want JSON value", config.OpenAI.APIKey)
	}
	if config.OpenAI.Model != "gpt-5-mini" {
		t.Fatalf("model = %q, want JSON value", config.OpenAI.Model)
	}
	if config.OpenAI.BaseURL != "https://api.example.com/v1" {
		t.Fatalf("baseURL = %q, want JSON value", config.OpenAI.BaseURL)
	}
	if config.OpenAI.ReasoningEffort != "medium" {
		t.Fatalf("reasoningEffort = %q, want JSON value", config.OpenAI.ReasoningEffort)
	}
	if config.Logging.Level != "info" || config.Logging.Format != "text" {
		t.Fatalf("default logging = %#v", config.Logging)
	}
	if config.Telegram.BotToken != "json-telegram-token" {
		t.Fatalf("botToken = %q, want JSON value", config.Telegram.BotToken)
	}
	if len(config.Telegram.AllowedUserIDs) != 1 || config.Telegram.AllowedUserIDs[0] != 123 {
		t.Fatalf("allowedUserIDs = %v, want [123]", config.Telegram.AllowedUserIDs)
	}
}

func TestLoadRejectsInvalidConfig(t *testing.T) {
	tests := []struct {
		name    string
		content string
		wantErr string
	}{
		{
			name:    "unknown field",
			content: `{"openai":{"apiKey":"key","model":"model","extra":true}}`,
			wantErr: `unknown field "extra"`,
		},
		{
			name:    "multiple values",
			content: `{"openai":{"apiKey":"key","model":"model"}} {}`,
			wantErr: "multiple JSON values",
		},
		{
			name:    "invalid log level",
			content: `{"logging":{"level":"trace"},"openai":{"apiKey":"key","model":"model"}}`,
			wantErr: `logging.level "trace" is invalid`,
		},
		{
			name:    "invalid log format",
			content: `{"logging":{"format":"pretty"},"openai":{"apiKey":"key","model":"model"}}`,
			wantErr: `logging.format "pretty" is invalid`,
		},
		{
			name:    "missing api key",
			content: `{"openai":{"model":"model"}}`,
			wantErr: "openai.apiKey is required",
		},
		{
			name:    "missing model",
			content: `{"openai":{"apiKey":"key"}}`,
			wantErr: "openai.model is required",
		},
		{
			name:    "missing message platform",
			content: `{"openai":{"apiKey":"key","model":"model"}}`,
			wantErr: "at least one message platform must be enabled",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeConfig(t, test.content)
			_, err := Load(path)
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("Load() error = %v, want error containing %q", err, test.wantErr)
			}
		})
	}
}

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}
