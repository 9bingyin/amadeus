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
		"models": {
			"assistant": {
				"provider": "gateway",
				"id": "gpt-5-mini",
				"reasoningEffort": "medium",
				"contextWindowTokens": 200000
			}
		},
		"model": "assistant",
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
	chat := config.Models["assistant"]
	if config.Model != "assistant" || chat.Provider != "gateway" {
		t.Fatalf("model = %q provider = %q", config.Model, chat.Provider)
	}
	if provider.API != APIOpenAIResponses {
		t.Fatalf("api = %q, want %q", provider.API, APIOpenAIResponses)
	}
	if provider.APIKey != "json-key" {
		t.Fatalf("apiKey = %q, want %q", provider.APIKey, "json-key")
	}
	if chat.ID != "gpt-5-mini" {
		t.Fatalf("model id = %q, want %q", chat.ID, "gpt-5-mini")
	}
	if provider.BaseURL != "https://api.example.com/v1" {
		t.Fatalf("baseURL = %q, want %q", provider.BaseURL, "https://api.example.com/v1")
	}
	if provider.HTTPVersion != "1.1" {
		t.Fatalf("httpVersion = %q, want 1.1", provider.HTTPVersion)
	}
	if chat.ReasoningEffort != "medium" {
		t.Fatalf("reasoningEffort = %q, want %q", chat.ReasoningEffort, "medium")
	}
	if chat.ContextWindowTokens != 200000 {
		t.Fatalf("contextWindowTokens = %d, want 200000", chat.ContextWindowTokens)
	}
	if len(chat.Input) != 1 || chat.Input[0] != "text" || chat.SupportsImage() || chat.SupportsFile() || chat.SupportsEmbeddings() {
		t.Fatalf("input = %#v", chat.Input)
	}
	if config.Search.Engine != SearchEngineFTS5 || config.Search.Model != "" {
		t.Fatalf("search = %#v", config.Search)
	}
	if !config.Compaction.Enabled || config.Compaction.ReserveTokens != 16384 || config.Compaction.KeepRecentTokens != 20000 ||
		!config.Compaction.Idle.Enabled || config.Compaction.Idle.AfterMS != 2_700_000 {
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
		"models": {
			"assistant": {
				"provider": "gateway",
				"id": "gpt-5-mini",
				"reasoningEffort": "medium"
			}
		},
		"model": "assistant",
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
	chat := config.Models["assistant"]
	if config.Model != "assistant" || chat.ID != "gpt-5-mini" {
		t.Fatalf("model = %q id = %q, want JSON value", config.Model, chat.ID)
	}
	if provider.BaseURL != "https://api.example.com/v1" {
		t.Fatalf("baseURL = %q, want JSON value", provider.BaseURL)
	}
	if chat.ReasoningEffort != "medium" {
		t.Fatalf("reasoningEffort = %q, want JSON value", chat.ReasoningEffort)
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
	if chat.ContextWindowTokens != 128000 {
		t.Fatalf("default contextWindowTokens = %d, want 128000", chat.ContextWindowTokens)
	}
	if !config.Compaction.Enabled || config.Compaction.ReserveTokens != 16384 || config.Compaction.KeepRecentTokens != 20000 ||
		!config.Compaction.Idle.Enabled || config.Compaction.Idle.AfterMS != 2_700_000 {
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
		"models":{"assistant":{"provider":"gateway","id":"model","input":["file","image"]}},
		"model":"assistant",
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"telegram":{"enabled":true}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	chat := config.Models["assistant"]
	if chat.SupportsText() || !chat.SupportsImage() || !chat.SupportsFile() || chat.SupportsEmbeddings() {
		t.Fatalf("input = %#v", chat.Input)
	}
	if len(chat.Input) != 2 || chat.Input[0] != "file" || chat.Input[1] != "image" {
		t.Fatalf("input = %#v", chat.Input)
	}
}

func TestLoadAllowsDisabledCompactionForSmallContextWindow(t *testing.T) {
	path := writeConfig(t, `{
		"models":{"assistant":{"provider":"gateway","id":"model","contextWindowTokens":8192}},
		"model":"assistant",
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"compaction":{"enabled":false},
		"telegram":{"enabled":true}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.Compaction.Enabled || config.Models["assistant"].ContextWindowTokens != 8192 {
		t.Fatalf("config = %#v", config)
	}
	if !config.Compaction.Idle.Enabled || config.Compaction.Idle.AfterMS != 2_700_000 {
		t.Fatalf("idle compaction = %#v", config.Compaction.Idle)
	}
}

func TestLoadDisablesIdleCompaction(t *testing.T) {
	path := writeConfig(t, `{
		"models":{"assistant":{"provider":"gateway","id":"model"}},
		"model":"assistant",
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"compaction":{"idle":{"enabled":false,"afterMs":60000}},
		"telegram":{"enabled":true}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !config.Compaction.Enabled || config.Compaction.Idle.Enabled || config.Compaction.Idle.AfterMS != 60000 {
		t.Fatalf("compaction = %#v", config.Compaction)
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
			content: `{"models":{"assistant":{"provider":"gateway","id":"model","extra":true}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: `unknown field "extra"`,
		},
		{
			name:    "multiple values",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}} {}`,
			wantErr: "multiple JSON values",
		},
		{
			name:    "invalid log level",
			content: `{"logging":{"level":"trace"},"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: `logging.level "trace" is invalid`,
		},
		{
			name:    "invalid log format",
			content: `{"logging":{"format":"pretty"},"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: `logging.format "pretty" is invalid`,
		},
		{
			name:    "negative input window",
			content: `{"gateway":{"inputWindowMs":-1},"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "gateway.inputWindowMs must be non-negative",
		},
		{
			name:    "invalid context window",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model","contextWindowTokens":-1}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "models.assistant.contextWindowTokens must be positive",
		},
		{
			name:    "negative reserve tokens",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"reserveTokens":-1},"telegram":{"enabled":true}}`,
			wantErr: "compaction.reserveTokens must be non-negative",
		},
		{
			name:    "idle compaction without delay",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"idle":{"afterMs":0}},"telegram":{"enabled":true}}`,
			wantErr: "compaction.idle.afterMs must be positive when idle compaction is enabled",
		},
		{
			name:    "zero reserve tokens",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"enabled":true,"reserveTokens":0},"telegram":{"enabled":true}}`,
			wantErr: "compaction.reserveTokens must be positive when compaction is enabled",
		},
		{
			name:    "negative keep recent tokens",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"keepRecentTokens":-1},"telegram":{"enabled":true}}`,
			wantErr: "compaction.keepRecentTokens must be non-negative",
		},
		{
			name:    "reserve exceeds window",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model","contextWindowTokens":1000}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"compaction":{"reserveTokens":1000},"telegram":{"enabled":true}}`,
			wantErr: "compaction.reserveTokens must be less than models.assistant.contextWindowTokens",
		},
		{
			name:    "negative retries",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"retry":{"maxRetries":-1},"telegram":{"enabled":true}}`,
			wantErr: "retry.maxRetries must be non-negative",
		},
		{
			name:    "negative base delay",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"retry":{"baseDelayMs":-1},"telegram":{"enabled":true}}`,
			wantErr: "retry.baseDelayMs must be non-negative",
		},
		{
			name:    "negative max delay",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"retry":{"maxAgentDelayMs":-1},"telegram":{"enabled":true}}`,
			wantErr: "retry.maxAgentDelayMs must be non-negative",
		},
		{
			name:    "duplicate provider header",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key","headers":{"x-opencode-session":"one","X-Opencode-Session":"two"}}},"telegram":{"enabled":true}}`,
			wantErr: `providers.gateway.headers "X-Opencode-Session" is duplicated`,
		},
		{
			name:    "empty provider header",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key","headers":{"x-opencode-session":" "}}},"telegram":{"enabled":true}}`,
			wantErr: `providers.gateway.headers "X-Opencode-Session" is empty`,
		},
		{
			name:    "invalid provider header",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key","headers":{"bad name":"value"}}},"telegram":{"enabled":true}}`,
			wantErr: `providers.gateway.headers "bad name" is invalid`,
		},
		{
			name:    "invalid HTTP version",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key","httpVersion":"2"}},"telegram":{"enabled":true}}`,
			wantErr: `providers.gateway.httpVersion "2" is invalid`,
		},
		{
			name:    "invalid model input",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model","input":["audio"]}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: `models.assistant.input "audio" is invalid`,
		},
		{
			name:    "empty model input",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model","input":[]}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "models.assistant.input is empty",
		},
		{
			name:    "missing provider",
			content: `{"models":{"assistant":{"id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: "models.assistant.provider is required",
		},
		{
			name:    "unconfigured provider",
			content: `{"models":{"assistant":{"provider":"anthropic","id":"claude"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: `models.assistant.provider "anthropic" is not configured`,
		},
		{
			name:    "unsupported api",
			content: `{"models":{"assistant":{"provider":"gateway","id":"claude"}},"model":"assistant","providers":{"gateway":{"api":"anthropic","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: `providers.gateway.api "anthropic" is not supported`,
		},
		{
			name:    "missing api key",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses"}},"telegram":{"enabled":true}}`,
			wantErr: "providers.gateway.apiKey is required",
		},
		{
			name:    "invalid search engine",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"search":{"engine":"bm25"},"telegram":{"enabled":true}}`,
			wantErr: `search.engine "bm25" is invalid`,
		},
		{
			name:    "vector search without model",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"search":{"engine":"vector"},"telegram":{"enabled":true}}`,
			wantErr: "search.model is required when search.engine is vector",
		},
		{
			name:    "search model is not embeddings",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"search":{"engine":"vector","model":"assistant"},"telegram":{"enabled":true}}`,
			wantErr: `models.assistant.input must include "embeddings"`,
		},
		{
			name:    "unknown search model",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"search":{"engine":"vector","model":"embed"},"telegram":{"enabled":true}}`,
			wantErr: `search.model "embed" is not configured`,
		},
		{
			name:    "embeddings model cannot chat",
			content: `{"models":{"embed":{"provider":"gateway","id":"text-embedding-3-small","input":["embeddings"]}},"model":"embed","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "models.embed.input must include text, image, or file",
		},
		{
			name:    "missing models",
			content: `{"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: "models is required",
		},
		{
			name:    "unknown selected model",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"other","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},"telegram":{"enabled":true}}`,
			wantErr: `model "other" is not configured`,
		},
		{
			name:    "missing model id",
			content: `{"models":{"assistant":{"provider":"gateway"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
			wantErr: "models.assistant.id is required",
		},
		{
			name:    "missing message platform",
			content: `{"models":{"assistant":{"provider":"gateway","id":"model"}},"model":"assistant","providers":{"gateway":{"api":"openai-responses","apiKey":"key"}}}`,
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

func TestLoadProviderHeaders(t *testing.T) {
	path := writeConfig(t, `{
		"models":{"assistant":{"provider":"gateway","id":"model"}},
		"model":"assistant",
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key","headers":{"x-opencode-session":"{session}","x-tenant":" personal "}}},
		"telegram":{"enabled":true}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	headers := config.Providers["gateway"].Headers
	if headers["X-Opencode-Session"] != "{session}" || headers["X-Tenant"] != "personal" || len(headers) != 2 {
		t.Fatalf("headers = %#v", headers)
	}
}

func TestLoadVectorSearch(t *testing.T) {
	path := writeConfig(t, `{
		"models":{
			"assistant":{"provider":"gateway","id":"model","input":["text","image"]},
			"embed":{"provider":"embedder","id":"text-embedding-3-small","input":["Embeddings"]}
		},
		"model":"assistant",
		"providers":{
			"gateway":{"api":"openai-responses","apiKey":"key"},
			"embedder":{"api":"openai-responses","apiKey":"embed-key","baseURL":"https://embed.example.com/v1"}
		},
		"search":{"engine":"Vector","model":"embed"},
		"telegram":{"enabled":true}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	chat := config.Models["assistant"]
	embed := config.Models["embed"]
	if config.Model != "assistant" || config.Search.Engine != SearchEngineVector || config.Search.Model != "embed" {
		t.Fatalf("model = %q search = %#v", config.Model, config.Search)
	}
	if !chat.SupportsText() || !chat.SupportsImage() || chat.SupportsEmbeddings() || chat.ContextWindowTokens != 128000 {
		t.Fatalf("chat = %#v", chat)
	}
	if embed.Provider != "embedder" || embed.ID != "text-embedding-3-small" || !embed.SupportsEmbeddings() || embed.SupportsText() || embed.ContextWindowTokens != 0 {
		t.Fatalf("embed = %#v", embed)
	}
}

func TestLoadMCPToolSelection(t *testing.T) {
	path := writeConfig(t, `{
		"models":{"assistant":{"provider":"gateway","id":"model"}},
		"model":"assistant",
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"telegram":{"enabled":true},
		"mcp":{
			"directTools": true,
			"servers":[{
				"name":"github",
				"transport":"stdio",
				"command":"server",
				"directTools":["search_repositories"],
				"includeTools":["search_*"],
				"excludeTools":["delete_*"]
			}]
		}
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.MCP.DirectTools == nil || !*config.MCP.DirectTools {
		t.Fatalf("directTools = %#v", config.MCP.DirectTools)
	}
	server := config.MCP.Servers[0]
	if !server.DirectTools.Set || server.DirectTools.All || len(server.DirectTools.Names) != 1 ||
		server.DirectTools.Names[0] != "search_repositories" {
		t.Fatalf("server directTools = %#v", server.DirectTools)
	}
	if len(server.IncludeTools) != 1 || server.IncludeTools[0] != "search_*" || server.ExcludeTools[0] != "delete_*" {
		t.Fatalf("tool filters = %#v %#v", server.IncludeTools, server.ExcludeTools)
	}

	rejected := writeConfig(t, `{
		"models":{"assistant":{"provider":"gateway","id":"model"}},
		"model":"assistant",
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"telegram":{"enabled":true},
		"mcp":{"servers":[{"name":"github","transport":"stdio","command":"server","directTools":"search"}]}
	}`)
	if _, err := Load(rejected); err == nil || !strings.Contains(err.Error(), "directTools must be true, false, or a list of tool names") {
		t.Fatalf("Load() error = %v", err)
	}
	empty := writeConfig(t, `{
		"models":{"assistant":{"provider":"gateway","id":"model"}},
		"model":"assistant",
		"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
		"telegram":{"enabled":true},
		"mcp":{"servers":[{"name":"github","transport":"stdio","command":"server","includeTools":[""]}]}
	}`)
	if _, err := Load(empty); err == nil || !strings.Contains(err.Error(), "includeTools contains an empty name") {
		t.Fatalf("Load() error = %v", err)
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
