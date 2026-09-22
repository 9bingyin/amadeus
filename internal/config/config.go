package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/textproto"
	"os"
	"slices"
	"strings"
	"time"
)

const (
	APIOpenAIResponses = "openai-responses"
	SearchEngineFTS5   = "fts5"
	SearchEngineVector = "vector"
)

type Model struct {
	Provider            string   `json:"provider"`
	ID                  string   `json:"id"`
	Input               []string `json:"input,omitempty"`
	ReasoningEffort     string   `json:"reasoningEffort,omitempty"`
	ContextWindowTokens int      `json:"contextWindowTokens"`
}

type Provider struct {
	API         string            `json:"api"`
	APIKey      string            `json:"apiKey"`
	BaseURL     string            `json:"baseURL,omitempty"`
	HTTPVersion string            `json:"httpVersion,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
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
	Name         string            `json:"name"`
	Transport    string            `json:"transport"`
	URL          string            `json:"url,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	Command      string            `json:"command,omitempty"`
	Args         []string          `json:"args,omitempty"`
	Env          map[string]string `json:"env,omitempty"`
	DirectTools  DirectTools       `json:"directTools,omitempty"`
	IncludeTools []string          `json:"includeTools,omitempty"`
	ExcludeTools []string          `json:"excludeTools,omitempty"`
}

// DirectTools selects MCP tools that stay in the model tool list.
// An unset value inherits mcp.directTools. True exposes every allowed tool.
// A list exposes only the named tools.
type DirectTools struct {
	Set   bool
	All   bool
	Names []string
}

func (d *DirectTools) UnmarshalJSON(data []byte) error {
	var all bool
	if err := json.Unmarshal(data, &all); err == nil {
		d.Set = true
		d.All = all
		d.Names = nil
		return nil
	}
	var names []string
	if err := json.Unmarshal(data, &names); err == nil {
		d.Set = true
		d.All = false
		d.Names = names
		return nil
	}
	return errors.New("directTools must be true, false, or a list of tool names")
}

func (d DirectTools) MarshalJSON() ([]byte, error) {
	if !d.Set {
		return []byte("null"), nil
	}
	if d.All {
		return []byte("true"), nil
	}
	if d.Names == nil {
		return []byte("false"), nil
	}
	return json.Marshal(d.Names)
}

type MCP struct {
	DirectTools *bool       `json:"directTools,omitempty"`
	Servers     []MCPServer `json:"servers,omitempty"`
}

type Search struct {
	Engine string `json:"engine,omitempty"`
	Model  string `json:"model,omitempty"`
}

type Config struct {
	Workspace  string              `json:"workspace,omitempty"`
	Gateway    Gateway             `json:"gateway"`
	Logging    Logging             `json:"logging"`
	Models     map[string]Model    `json:"models"`
	Model      string              `json:"model"`
	Providers  map[string]Provider `json:"providers"`
	Compaction Compaction          `json:"compaction"`
	Retry      Retry               `json:"retry"`
	Telegram   Telegram            `json:"telegram"`
	MCP        MCP                 `json:"mcp"`
	Search     Search              `json:"search"`
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config %q: %w", path, err)
	}

	config := Config{
		Gateway: Gateway{InputWindowMS: 700},
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
	config.Model = strings.TrimSpace(config.Model)
	search, err := normalizeSearch(config.Search)
	if err != nil {
		return Config{}, err
	}
	config.Search = search
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
	if config.Model == "" {
		return Config{}, errors.New("model is required")
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
	providers, err := normalizeProviders(config.Providers)
	if err != nil {
		return Config{}, err
	}
	config.Providers = providers
	models, err := normalizeModels(config.Models, config.Providers)
	if err != nil {
		return Config{}, err
	}
	config.Models = models
	chat, ok := config.Models[config.Model]
	if !ok {
		return Config{}, fmt.Errorf("model %q is not configured", config.Model)
	}
	if !chat.SupportsText() && !chat.SupportsImage() && !chat.SupportsFile() {
		return Config{}, fmt.Errorf("models.%s.input must include text, image, or file", config.Model)
	}
	if chat.ContextWindowTokens == 0 {
		chat.ContextWindowTokens = defaultContextWindowTokens
		config.Models[config.Model] = chat
	}
	if config.Search.Model != "" {
		embeddingModel, exists := config.Models[config.Search.Model]
		if !exists {
			return Config{}, fmt.Errorf("search.model %q is not configured", config.Search.Model)
		}
		if !embeddingModel.SupportsEmbeddings() {
			return Config{}, fmt.Errorf("models.%s.input must include %q", config.Search.Model, "embeddings")
		}
	}
	if config.Compaction.Enabled && config.Compaction.ReserveTokens >= chat.ContextWindowTokens {
		return Config{}, fmt.Errorf("compaction.reserveTokens must be less than models.%s.contextWindowTokens", config.Model)
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
	if !config.Telegram.Enabled {
		return Config{}, errors.New("at least one message platform must be enabled")
	}
	if err := normalizeMCP(&config.MCP); err != nil {
		return Config{}, err
	}

	return config, nil
}

func normalizeMCP(mcp *MCP) error {
	for index := range mcp.Servers {
		server := &mcp.Servers[index]
		if err := normalizeToolNames(fmt.Sprintf("mcp.servers[%d].directTools", index), server.DirectTools.Names); err != nil {
			return err
		}
		if err := normalizeToolNames(fmt.Sprintf("mcp.servers[%d].includeTools", index), server.IncludeTools); err != nil {
			return err
		}
		if err := normalizeToolNames(fmt.Sprintf("mcp.servers[%d].excludeTools", index), server.ExcludeTools); err != nil {
			return err
		}
	}
	return nil
}

func normalizeToolNames(field string, names []string) error {
	for _, name := range names {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("%s contains an empty name", field)
		}
	}
	return nil
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

func (m Model) SupportsEmbeddings() bool {
	return modelInputEnabled(m.Input, "embeddings")
}

func modelInputEnabled(input []string, kind string) bool {
	return slices.Contains(input, kind)
}

const defaultContextWindowTokens = 128000

func normalizeModels(models map[string]Model, providers map[string]Provider) (map[string]Model, error) {
	if len(models) == 0 {
		return nil, errors.New("models is required")
	}
	normalized := make(map[string]Model, len(models))
	for name, model := range models {
		name = strings.TrimSpace(name)
		if name == "" {
			return nil, errors.New("models has an empty name")
		}
		if _, exists := normalized[name]; exists {
			return nil, fmt.Errorf("models.%s is duplicated", name)
		}
		model.Provider = strings.TrimSpace(model.Provider)
		model.ID = strings.TrimSpace(model.ID)
		model.ReasoningEffort = strings.TrimSpace(model.ReasoningEffort)
		if model.Provider == "" {
			return nil, fmt.Errorf("models.%s.provider is required", name)
		}
		if model.ID == "" {
			return nil, fmt.Errorf("models.%s.id is required", name)
		}
		if _, ok := providers[model.Provider]; !ok {
			return nil, fmt.Errorf("models.%s.provider %q is not configured", name, model.Provider)
		}
		if model.ContextWindowTokens < 0 {
			return nil, fmt.Errorf("models.%s.contextWindowTokens must be positive", name)
		}
		input, err := normalizeModelInput(name, model.Input)
		if err != nil {
			return nil, err
		}
		model.Input = input
		normalized[name] = model
	}
	return normalized, nil
}

func normalizeModelInput(name string, input []string) ([]string, error) {
	if input == nil {
		return []string{"text"}, nil
	}
	if len(input) == 0 {
		return nil, fmt.Errorf("models.%s.input is empty", name)
	}
	normalized := make([]string, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, item := range input {
		item = strings.ToLower(strings.TrimSpace(item))
		switch item {
		case "text", "image", "file", "embeddings":
		default:
			return nil, fmt.Errorf("models.%s.input %q is invalid", name, item)
		}
		if _, ok := seen[item]; ok {
			return nil, fmt.Errorf("models.%s.input %q is duplicated", name, item)
		}
		seen[item] = struct{}{}
		normalized = append(normalized, item)
	}
	return normalized, nil
}

func normalizeSearch(search Search) (Search, error) {
	search.Engine = strings.ToLower(strings.TrimSpace(search.Engine))
	search.Model = strings.TrimSpace(search.Model)
	if search.Engine == "" {
		search.Engine = SearchEngineFTS5
	}
	switch search.Engine {
	case SearchEngineFTS5:
		return search, nil
	case SearchEngineVector:
		if search.Model == "" {
			return Search{}, errors.New("search.model is required when search.engine is vector")
		}
		return search, nil
	default:
		return Search{}, fmt.Errorf("search.engine %q is invalid", search.Engine)
	}
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
		headers, err := normalizeHeaders(name, provider.Headers)
		if err != nil {
			return nil, err
		}
		provider.Headers = headers
		normalized[name] = provider
	}
	return normalized, nil
}

func normalizeHeaders(providerName string, headers map[string]string) (map[string]string, error) {
	if len(headers) == 0 {
		return nil, nil
	}
	normalized := make(map[string]string, len(headers))
	for name, value := range headers {
		name = strings.TrimSpace(name)
		if name == "" {
			return nil, fmt.Errorf("providers.%s.headers has an empty name", providerName)
		}
		if !validHeaderName(name) {
			return nil, fmt.Errorf("providers.%s.headers %q is invalid", providerName, name)
		}
		canonical := textproto.CanonicalMIMEHeaderKey(name)
		if _, exists := normalized[canonical]; exists {
			return nil, fmt.Errorf("providers.%s.headers %q is duplicated", providerName, canonical)
		}
		value = strings.TrimSpace(value)
		if value == "" {
			return nil, fmt.Errorf("providers.%s.headers %q is empty", providerName, canonical)
		}
		if strings.ContainsAny(value, "\r\n") {
			return nil, fmt.Errorf("providers.%s.headers %q is invalid", providerName, canonical)
		}
		normalized[canonical] = value
	}
	return normalized, nil
}

func validHeaderName(name string) bool {
	for index := range len(name) {
		character := name[index]
		if character <= ' ' || character >= 127 || strings.ContainsRune(headerNameSeparators, rune(character)) {
			return false
		}
	}
	return name != ""
}

const headerNameSeparators = "\"(),/:;<=>?@[\\]{}"
