package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

type OpenAI struct {
	APIKey          string `json:"apiKey"`
	Model           string `json:"model"`
	BaseURL         string `json:"baseURL,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
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
	Workspace string   `json:"workspace,omitempty"`
	Logging   Logging  `json:"logging"`
	OpenAI    OpenAI   `json:"openai"`
	Telegram  Telegram `json:"telegram"`
	MCP       MCP      `json:"mcp"`
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config %q: %w", path, err)
	}

	var config Config
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
	config.OpenAI.APIKey = strings.TrimSpace(config.OpenAI.APIKey)
	config.OpenAI.Model = strings.TrimSpace(config.OpenAI.Model)
	config.OpenAI.BaseURL = strings.TrimSpace(config.OpenAI.BaseURL)
	config.OpenAI.ReasoningEffort = strings.TrimSpace(config.OpenAI.ReasoningEffort)
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
	if config.OpenAI.APIKey == "" {
		return Config{}, errors.New("openai.apiKey is required")
	}
	if config.OpenAI.Model == "" {
		return Config{}, errors.New("openai.model is required")
	}
	if !config.Telegram.Enabled {
		return Config{}, errors.New("at least one message platform must be enabled")
	}

	return config, nil
}
