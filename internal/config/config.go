package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"
)

const APIOpenAIResponses = "openai-responses"

type Model struct {
	Provider            string   `json:"provider"`
	ID                  string   `json:"id"`
	Input               []string `json:"input,omitempty"`
	ReasoningEffort     string   `json:"reasoningEffort,omitempty"`
	ContextWindowTokens int      `json:"contextWindowTokens"`
}

type Provider struct {
	API         string `json:"api"`
	APIKey      string `json:"apiKey"`
	BaseURL     string `json:"baseURL,omitempty"`
	HTTPVersion string `json:"httpVersion,omitempty"`
}

type Compaction struct {
	Enabled          bool `json:"enabled"`
	ReserveTokens    int  `json:"reserveTokens"`
	KeepRecentTokens int  `json:"keepRecentTokens"`
}

type Retry struct {
	Enabled         bool `json:"enabled"`
	MaxRetries      int  `json:"maxRetries"`
	BaseDelayMS     int  `json:"baseDelayMs"`
	MaxAgentDelayMS int  `json:"maxAgentDelayMs"`
}

type Gateway struct {
	InputWindowMS int `json:"inputWindowMs"`
}

type Logging struct {
	Level     string `json:"level,omitempty"`
	Format    string `json:"format,omitempty"`
	AddSource bool   `json:"addSource,omitempty"`
}

type Telegram struct {
	Enabled        bool    `json:"enabled"`
	BotToken       string  `json:"botToken,omitempty"`
	AllowedUserIDs []int64 `json:"allowedUserIDs,omitempty"`
}

type MCPServer struct {
	Name      string            `json:"name"`
	Transport string            `json:"transport"`
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
}

type MCP struct {
	Servers []MCPServer `json:"servers,omitempty"`
}

type Config struct {
	Workspace  string              `json:"workspace,omitempty"`
	Gateway    Gateway             `json:"gateway"`
	Logging    Logging             `json:"logging"`
	Model      Model               `json:"model"`
	Providers  map[string]Provider `json:"providers"`
	Compaction Compaction          `json:"compaction"`
	Retry      Retry               `json:"retry"`
	Telegram   Telegram            `json:"telegram"`
	MCP        MCP                 `json:"mcp"`
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config %q: %w", path, err)
	}

	config := Config{
		Gateway: Gateway{InputWindowMS: 700},
		Model:   Model{ContextWindowTokens: 128000},
		Compaction: Compaction{
			Enabled: true, ReserveTokens: 16384, KeepRecentTokens: 20000,
		},
		Retry: Retry{
			Enabled:         true,
			MaxRetries:      3,
			BaseDelayMS:     2000,
			MaxAgentDelayMS: 60000,
		},
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return Config{}, fmt.Errorf("decode config %q: %w", path, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return Config{}, fmt.Errorf("decode config %q: multiple JSON values", path)
		}
		return Config{}, fmt.Errorf("decode config %q: %w", path, err)
	}

	config.Workspace = strings.TrimSpace(config.Workspace)
	config.Logging.Level = strings.ToLower(strings.TrimSpace(config.Logging.Level))
	if config.Logging.Level == "" {
		config.Logging.Level = "info"
	}
	config.Logging.Format = strings.ToLower(strings.TrimSpace(config.Logging.Format))
	if config.Logging.Format == "" {
		config.Logging.Format = "text"
	}
	config.Model.Provider = strings.TrimSpace(config.Model.Provider)
	config.Model.ID = strings.TrimSpace(config.Model.ID)
	config.Model.ReasoningEffort = strings.TrimSpace(config.Model.ReasoningEffort)
	input, err := normalizeModelInput(config.Model.Input)
	if err != nil {
		return Config{}, err
	}
	config.Model.Input = input
	config.Telegram.BotToken = strings.TrimSpace(config.Telegram.BotToken)

	switch config.Logging.Level {
	case "debug", "info", "warn", "error":
	default:
		return Config{}, fmt.Errorf("logging.level %q is invalid", config.Logging.Level)
	}
	switch config.Logging.Format {
	case "text", "json":
	default:
		return Config{}, fmt.Errorf("logging.format %q is invalid", config.Logging.Format)
	}
	if config.Gateway.InputWindowMS < 0 {
		return Config{}, errors.New("gateway.inputWindowMs must be non-negative")
	}
	if config.Model.Provider == "" {
		return Config{}, errors.New("model.provider is required")
	}
	if config.Model.ID == "" {
		return Config{}, errors.New("model.id is required")
	}
	if config.Model.ContextWindowTokens <= 0 {
		return Config{}, errors.New("model.contextWindowTokens must be positive")
	}
	if config.Compaction.ReserveTokens < 0 {
		return Config{}, errors.New("compaction.reserveTokens must be non-negative")
	}
	if config.Compaction.KeepRecentTokens < 0 {
		return Config{}, errors.New("compaction.keepRecentTokens must be non-negative")
	}
	if config.Compaction.Enabled && config.Compaction.ReserveTokens == 0 {
		return Config{}, errors.New("compaction.reserveTokens must be positive when compaction is enabled")
	}
	if config.Compaction.Enabled && config.Compaction.ReserveTokens >= config.Model.ContextWindowTokens {
		return Config{}, errors.New("compaction.reserveTokens must be less than model.contextWindowTokens")
	}
	if config.Retry.MaxRetries < 0 {
		return Config{}, errors.New("retry.maxRetries must be non-negative")
	}
	if config.Retry.BaseDelayMS < 0 {
		return Config{}, errors.New("retry.baseDelayMs must be non-negative")
	}
	if config.Retry.MaxAgentDelayMS < 0 {
		return Config{}, errors.New("retry.maxAgentDelayMs must be non-negative")
	}
	const maxDurationMilliseconds = int64((1<<63 - 1) / time.Millisecond)
	if int64(config.Gateway.InputWindowMS) > maxDurationMilliseconds {
		return Config{}, errors.New("gateway.inputWindowMs is too large")
	}
	if int64(config.Retry.BaseDelayMS) > maxDurationMilliseconds {
		return Config{}, errors.New("retry.baseDelayMs is too large")
	}
	if int64(config.Retry.MaxAgentDelayMS) > maxDurationMilliseconds {
		return Config{}, errors.New("retry.maxAgentDelayMs is too large")
	}
	providers, err := normalizeProviders(config.Providers)
	if err != nil {
		return Config{}, err
	}
	config.Providers = providers
	if _, ok := config.Providers[config.Model.Provider]; !ok {
		return Config{}, fmt.Errorf("model.provider %q is not configured", config.Model.Provider)
	}
	if !config.Telegram.Enabled {
		return Config{}, errors.New("at least one message platform must be enabled")
	}

	return config, nil
}

func (m Model) SupportsText() bool {
	return modelInputEnabled(m.Input, "text")
}

func (m Model) SupportsImage() bool {
	return modelInputEnabled(m.Input, "image")
}

func (m Model) SupportsFile() bool {
	return modelInputEnabled(m.Input, "file")
}

func modelInputEnabled(input []string, kind string) bool {
	return slices.Contains(input, kind)
}

func normalizeModelInput(input []string) ([]string, error) {
	if input == nil {
		return []string{"text"}, nil
	}
	if len(input) == 0 {
		return nil, errors.New("model.input is empty")
	}
	normalized := make([]string, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, item := range input {
		item = strings.ToLower(strings.TrimSpace(item))
		switch item {
		case "text", "image", "file":
		default:
			return nil, fmt.Errorf("model.input %q is invalid", item)
		}
		if _, ok := seen[item]; ok {
			return nil, fmt.Errorf("model.input %q is duplicated", item)
		}
		seen[item] = struct{}{}
		normalized = append(normalized, item)
	}
	return normalized, nil
}

func normalizeProviders(providers map[string]Provider) (map[string]Provider, error) {
	if len(providers) == 0 {
		return nil, errors.New("providers is required")
	}
	normalized := make(map[string]Provider, len(providers))
	for name, provider := range providers {
		name = strings.TrimSpace(name)
		if name == "" {
			return nil, errors.New("providers has an empty name")
		}
		if _, exists := normalized[name]; exists {
			return nil, fmt.Errorf("providers.%s is duplicated", name)
		}
		provider.API = strings.TrimSpace(provider.API)
		provider.APIKey = strings.TrimSpace(provider.APIKey)
		provider.BaseURL = strings.TrimSpace(provider.BaseURL)
		provider.HTTPVersion = strings.ToLower(strings.TrimSpace(provider.HTTPVersion))
		if provider.API == "" {
			return nil, fmt.Errorf("providers.%s.api is required", name)
		}
		switch provider.API {
		case APIOpenAIResponses:
			if provider.HTTPVersion == "" {
				provider.HTTPVersion = "auto"
			}
			switch provider.HTTPVersion {
			case "auto", "1.1":
			default:
				return nil, fmt.Errorf("providers.%s.httpVersion %q is invalid", name, provider.HTTPVersion)
			}
			if provider.APIKey == "" {
				return nil, fmt.Errorf("providers.%s.apiKey is required", name)
			}
		default:
			return nil, fmt.Errorf("providers.%s.api %q is not supported", name, provider.API)
		}
		normalized[name] = provider
	}
	return normalized, nil
}
