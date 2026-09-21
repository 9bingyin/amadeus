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
		"gateway": {"inputWindowMs": 250},
		"logging": {"level": "DEBUG", "format": "JSON", "addSource": true},
		"model": {
			"provider": "gateway",
			"id": "gpt-5-mini",
			"reasoningEffort": "medium",
			"contextWindowTokens": 200000
		},
		"providers": {
			"gateway": {
				"api": "openai-responses",
				"apiKey": "json-key",
				"baseURL": "https://api.example.com/v1",
				"httpVersion": "1.1"
			}
		},
		"compaction": {
			"enabled": true,
			"reserveTokens": 16384,
			"keepRecentTokens": 20000
		},
		"retry": {
			"enabled": false,
			"maxRetries": 5,
			"baseDelayMs": 100,
			"maxAgentDelayMs": 1000
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
	if config.Gateway.InputWindowMS != 250 {
		t.Fatalf("inputWindowMs = %d, want 250", config.Gateway.InputWindowMS)
	}
	if config.Logging.Level != "debug" || config.Logging.Format != "json" || !config.Logging.AddSource {
		t.Fatalf("logging = %#v", config.Logging)
	}
	provider := config.Providers["gateway"]
	if config.Model.Provider != "gateway" {
		t.Fatalf("provider = %q, want %q", config.Model.Provider, "gateway")
	}
	if provider.API != APIOpenAIResponses {
		t.Fatalf("api = %q, want %q", provider.API, APIOpenAIResponses)
	}
	if provider.APIKey != "json-key" {
		t.Fatalf("apiKey = %q, want %q", provider.APIKey, "json-key")
	}
	if config.Model.ID != "gpt-5-mini" {
		t.Fatalf("model = %q, want %q", config.Model.ID, "gpt-5-mini")
	}
	if provider.BaseURL != "https://api.example.com/v1" {
		t.Fatalf("baseURL = %q, want %q", provider.BaseURL, "https://api.example.com/v1")
	}
	if provider.HTTPVersion != "1.1" {
		t.Fatalf("httpVersion = %q, want 1.1", provider.HTTPVersion)
	}
	if config.Model.ReasoningEffort != "medium" {
		t.Fatalf("reasoningEffort = %q, want %q", config.Model.ReasoningEffort, "medium")
	}
	if config.Model.ContextWindowTokens != 200000 {
		t.Fatalf("contextWindowTokens = %d, want 200000", config.Model.ContextWindowTokens)
	}
	if len(config.Model.Input) != 1 || config.Model.Input[0] != "text" || config.Model.SupportsImage() || config.Model.SupportsFile() {
		t.Fatalf("input = %#v", config.Model.Input)
	}
	if !config.Compaction.Enabled || config.Compaction.ReserveTokens != 16384 || config.Compaction.KeepRecentTokens != 20000 {
		t.Fatalf("compaction = %#v", config.Compaction)
	}
	if config.Retry.Enabled || config.Retry.MaxRetries != 5 || config.Retry.BaseDelayMS != 100 || config.Retry.MaxAgentDelayMS != 1000 {
		t.Fatalf("retry = %#v", config.Retry)
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
		"model": {
			"provider": "gateway",
			"id": "gpt-5-mini",
			"reasoningEffort": "medium"
		},
		"providers": {
			"gateway": {
				"api": "openai-responses",
				"apiKey": "json-key",
				"baseURL": "https://api.example.com/v1"
			}
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
	provider := config.Providers["gateway"]
	if provider.APIKey != "json-key" {
		t.Fatalf("apiKey = %q, want JSON value", provider.APIKey)
	}
	if config.Model.ID != "gpt-5-mini" {
		t.Fatalf("model = %q, want JSON value", config.Model.ID)
	}
	if provider.BaseURL != "https://api.example.com/v1" {
		t.Fatalf("baseURL = %q, want JSON value", provider.BaseURL)
	}
	if config.Model.ReasoningEffort != "medium" {
		t.Fatalf("reasoningEffort = %q, want JSON value", config.Model.ReasoningEffort)
	}
	if config.Logging.Level != "info" || config.Logging.Format != "text" {
		t.Fatalf("default logging = %#v", config.Logging)
	}
	if config.Gateway.InputWindowMS != 700 {
		t.Fatalf("default inputWindowMs = %d, want 700", config.Gateway.InputWindowMS)
	}
	if config.Providers["gateway"].HTTPVersion != "auto" {
		t.Fatalf("default httpVersion = %q, want auto", config.Providers["gateway"].HTTPVersion)
	}
	if config.Model.ContextWindowTokens != 128000 {
		t.Fatalf("default contextWindowTokens = %d, want 128000", config.Model.ContextWindowTokens)
	}
	if !config.Compaction.Enabled || config.Compaction.ReserveTokens != 16384 || config.Compaction.KeepRecentTokens != 20000 {
		t.Fatalf("default compaction = %#v", config.Compaction)
	}
	if !config.Retry.Enabled || config.Retry.MaxRetries != 3 || config.Retry.BaseDelayMS != 2000 || config.Retry.MaxAgentDelayMS != 60000 {
		t.Fatalf("default retry = %#v", config.Retry)
	}
	if config.Telegram.BotToken != "json-telegram-token" {
		t.Fatalf("botToken = %q, want JSON value", config.Telegram.BotToken)
	}
	if len(config.Telegram.AllowedUserIDs) != 1 || config.Telegram.AllowedUserIDs[0] != 123 {
		t.Fatalf("allowedUserIDs = %v, want [123]", config.Telegram.AllowedUserIDs)
	}
}

func TestLoadEnablesConfiguredModelInput(t *testing.T) {
	path := writeConfig(t, `{
		"model":{"provider":"gateway","id":"model","input":["file","image"]},
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"telegram":{"enabled":true}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.Model.SupportsText() || !config.Model.SupportsImage() || !config.Model.SupportsFile() {
		t.Fatalf("input = %#v", config.Model.Input)
	}
	if len(config.Model.Input) != 2 || config.Model.Input[0] != "file" || config.Model.Input[1] != "image" {
		t.Fatalf("input = %#v", config.Model.Input)
	}
}

func TestLoadAllowsDisabledCompactionForSmallContextWindow(t *testing.T) {
	path := writeConfig(t, `{
		"model":{"provider":"gateway","id":"model","contextWindowTokens":8192},
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"compaction":{"enabled":false},
		"telegram":{"enabled":true}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.Compaction.Enabled || config.Model.ContextWindowTokens != 8192 {
		t.Fatalf("config = %#v", config)
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
			content: `{"model":{"provider":"gateway","id":"model","extra":true},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: `unknown field "extra"`,
		},
		{
			name:    "multiple values",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}} {}`,
			wantErr: "multiple JSON values",
		},
		{
			name:    "invalid log level",
			content: `{"logging":{"level":"trace"},"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: `logging.level "trace" is invalid`,
		},
		{
			name:    "invalid log format",
			content: `{"logging":{"format":"pretty"},"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: `logging.format "pretty" is invalid`,
		},
		{
			name:    "negative input window",
			content: `{"gateway":{"inputWindowMs":-1},"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "gateway.inputWindowMs must be non-negative",
		},
		{
			name:    "invalid context window",
			content: `{"model":{"provider":"gateway","id":"model","contextWindowTokens":-1},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "model.contextWindowTokens must be positive",
		},
		{
			name:    "negative reserve tokens",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"reserveTokens":-1},"telegram":{"enabled":true}}`,
			wantErr: "compaction.reserveTokens must be non-negative",
		},
		{
			name:    "zero reserve tokens",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"enabled":true,"reserveTokens":0},"telegram":{"enabled":true}}`,
			wantErr: "compaction.reserveTokens must be positive when compaction is enabled",
		},
		{
			name:    "negative keep recent tokens",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"keepRecentTokens":-1},"telegram":{"enabled":true}}`,
			wantErr: "compaction.keepRecentTokens must be non-negative",
		},
		{
			name:    "reserve exceeds window",
			content: `{"model":{"provider":"gateway","id":"model","contextWindowTokens":1000},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"reserveTokens":1000},"telegram":{"enabled":true}}`,
			wantErr: "compaction.reserveTokens must be less than model.contextWindowTokens",
		},
		{
			name:    "negative retries",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"retry":{"maxRetries":-1},"telegram":{"enabled":true}}`,
			wantErr: "retry.maxRetries must be non-negative",
		},
		{
			name:    "negative base delay",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"retry":{"baseDelayMs":-1},"telegram":{"enabled":true}}`,
			wantErr: "retry.baseDelayMs must be non-negative",
		},
		{
			name:    "negative max delay",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"retry":{"maxAgentDelayMs":-1},"telegram":{"enabled":true}}`,
			wantErr: "retry.maxAgentDelayMs must be non-negative",
		},
		{
			name:    "invalid HTTP version",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key","httpVersion":"2"}},"telegram":{"enabled":true}}`,
			wantErr: `providers.gateway.httpVersion "2" is invalid`,
		},
		{
			name:    "invalid model input",
			content: `{"model":{"provider":"gateway","id":"model","input":["audio"]},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: `model.input "audio" is invalid`,
		},
		{
			name:    "empty model input",
			content: `{"model":{"provider":"gateway","id":"model","input":[]},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "model.input is empty",
		},
		{
			name:    "missing provider",
			content: `{"model":{"id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: "model.provider is required",
		},
		{
			name:    "unconfigured provider",
			content: `{"model":{"provider":"anthropic","id":"claude"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: `model.provider "anthropic" is not configured`,
		},
		{
			name:    "unsupported api",
			content: `{"model":{"provider":"gateway","id":"claude"},"providers":{"gateway":{"api":"anthropic","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: `providers.gateway.api "anthropic" is not supported`,
		},
		{
			name:    "missing api key",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses"}},"telegram":{"enabled":true}}`,
			wantErr: "providers.gateway.apiKey is required",
		},
		{
			name:    "missing model",
			content: `{"model":{"provider":"gateway"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: "model.id is required",
		},
		{
			name:    "missing message platform",
			content: `{"model":{"provider":"gateway","id":"model"},"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
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
