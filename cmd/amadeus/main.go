package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/config"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/9bingyin/amadeus/internal/gateway"
	"github.com/9bingyin/amadeus/internal/logging"
	"github.com/9bingyin/amadeus/internal/paths"
	"github.com/9bingyin/amadeus/internal/platform/telegram"
	"github.com/9bingyin/amadeus/internal/skills"
	"github.com/9bingyin/amadeus/internal/tools"
	"github.com/9bingyin/amadeus/internal/tools/mcp"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	started := time.Now()
	if !finishRun(ctx, started, run(ctx, os.Args[1:])) {
		os.Exit(1)
	}
}

func finishRun(ctx context.Context, started time.Time, err error) bool {
	if err != nil {
		slog.ErrorContext(ctx, "Amadeus stopped", "duration", time.Since(started), "err", err)
		return false
	}
	slog.InfoContext(ctx, "Amadeus stopped", "duration", time.Since(started))
	return true
}

func run(ctx context.Context, args []string) (returnErr error) {
	if len(args) != 0 {
		return errors.New("usage: amadeus")
	}
	configPath, err := paths.ConfigFile()
	if err != nil {
		return err
	}
	settings, err := config.Load(configPath)
	if err != nil {
		return err
	}
	logger, err := logging.New(logging.Config{
		Level: settings.Logging.Level, Format: settings.Logging.Format, AddSource: settings.Logging.AddSource,
	}, os.Stderr)
	if err != nil {
		return fmt.Errorf("configure logging: %w", err)
	}
	slog.SetDefault(logger)
	slog.DebugContext(ctx, "Loaded configuration", "path", configPath, "config", settings)

	telegramConfig := telegram.Config{
		BotToken:       settings.Telegram.BotToken,
		AllowedUserIDs: settings.Telegram.AllowedUserIDs,
	}
	if settings.Telegram.Enabled {
		if err := telegram.Validate(telegramConfig); err != nil {
			return fmt.Errorf("configure Telegram: %w", err)
		}
		attachmentsDir, err := paths.AttachmentsDirectory()
		if err != nil {
			return fmt.Errorf("resolve attachments directory: %w", err)
		}
		if err := os.MkdirAll(attachmentsDir, 0o700); err != nil {
			return fmt.Errorf("create attachments directory %q: %w", attachmentsDir, err)
		}
		telegramConfig.AttachmentsDir = attachmentsDir
	}
	slog.InfoContext(ctx, "Starting Amadeus")
	runtime, err := newAgentRuntime(ctx, settings)
	if err != nil {
		return err
	}
	defer func() {
		if err := runtime.Close(); err != nil {
			returnErr = errors.Join(returnErr, err)
		}
	}()

	if settings.Telegram.Enabled {
		slog.InfoContext(ctx, "Starting message platform", "platform", "telegram")
		service, err := telegram.New(telegramConfig, runtime.gateway)
		if err != nil {
			return fmt.Errorf("configure Telegram: %w", err)
		}
		service.BindSendFiles(runtime.telegramFiles)
		if observer, ok := runtime.gateway.(interface {
			SetToolObserver(agent.ToolObserver)
		}); ok {
			observer.SetToolObserver(service)
		}
		return service.Run(ctx)
	}
	return errors.New("no message platform is enabled")
}

type platformGateway interface {
	gateway.Handler
	gateway.Submitter
	Close()
}

type agentRuntime struct {
	gateway       platformGateway
	toolSet       *mcp.Set
	store         *conversation.Store
	telegramFiles *telegram.SendFiles
}

func newAgentRuntime(ctx context.Context, settings config.Config) (*agentRuntime, error) {
	var availableSkills []skills.Skill
	skillsDirectory, err := paths.SkillsDirectory()
	if err != nil {
		slog.Warn("Global skills are unavailable", "err", err)
	} else {
		availableSkills, err = skills.Discover(skillsDirectory)
		if err != nil {
			slog.Warn("Global skills are unavailable", "path", skillsDirectory, "err", err)
			availableSkills = nil
		}
	}
	slog.DebugContext(ctx, "Discovered global skills", "skills", availableSkills)
	home, err := paths.Directory()
	if err != nil {
		return nil, fmt.Errorf("resolve amadeus home: %w", err)
	}
	workspace, err := paths.WorkspaceDirectory(settings.Workspace)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace: %w", err)
	}
	slog.InfoContext(ctx, "Configured agent workspace", "path", workspace)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return nil, fmt.Errorf("create workspace %q: %w", workspace, err)
	}
	go tools.MaintainToolOutput(ctx)
	basicTools, err := tools.New(workspace)
	if err != nil {
		return nil, fmt.Errorf("configure tools: %w", err)
	}
	var telegramFiles *telegram.SendFiles
	if settings.Telegram.Enabled {
		telegramFiles, err = telegram.NewSendFiles(workspace)
		if err != nil {
			return nil, fmt.Errorf("configure send_file: %w", err)
		}
		basicTools = append(basicTools, telegramFiles.Tool())
	}
	slog.DebugContext(ctx, "Configured local tools", "tools", basicTools)
	servers := make([]mcp.Server, len(settings.MCP.Servers))
	for index, server := range settings.MCP.Servers {
		servers[index] = mcp.Server{
			Name:      server.Name,
			Transport: server.Transport,
			URL:       server.URL,
			Headers:   server.Headers,
			Command:   server.Command,
			Args:      server.Args,
			Env:       server.Env,
		}
	}
	toolSet, err := mcp.Load(ctx, workspace, servers, basicTools)
	if err != nil {
		return nil, fmt.Errorf("configure MCP tools: %w", err)
	}
	agentTools := toolSet.Tools()
	soul, globalAgents, workspaceAgents, err := agent.LoadPromptFiles(home, workspace)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("load prompt files: %w", err), toolSet.Close())
	}
	slog.DebugContext(ctx, "Loaded prompt files", "soul", soul != "", "agents", globalAgents != "", "workspace_agents", workspaceAgents != "")
	systemPrompt := agent.BuildSystemPrompt(
		workspace, settings.Telegram.Enabled, skills.SystemPrompt(availableSkills),
		soul, globalAgents, workspaceAgents,
	)
	selected, ok := settings.Providers[settings.Model.Provider]
	if !ok {
		return nil, errors.Join(fmt.Errorf("model.provider %q is not configured", settings.Model.Provider), toolSet.Close())
	}
	if selected.API != config.APIOpenAIResponses {
		return nil, errors.Join(
			fmt.Errorf("providers.%s.api %q is not supported", settings.Model.Provider, selected.API),
			toolSet.Close(),
		)
	}
	loop, err := agent.New(agent.Config{
		APIKey:          selected.APIKey,
		Model:           settings.Model.ID,
		BaseURL:         selected.BaseURL,
		HTTPVersion:     selected.HTTPVersion,
		ReasoningEffort: settings.Model.ReasoningEffort,
		Input: agent.ModelInput{
			Text:  settings.Model.SupportsText(),
			Image: settings.Model.SupportsImage(),
			File:  settings.Model.SupportsFile(),
		},
		SystemPrompt: systemPrompt,
		Retry: agent.RetryConfig{
			Enabled:       settings.Retry.Enabled,
			MaxRetries:    settings.Retry.MaxRetries,
			BaseDelay:     time.Duration(settings.Retry.BaseDelayMS) * time.Millisecond,
			MaxAgentDelay: time.Duration(settings.Retry.MaxAgentDelayMS) * time.Millisecond,
		},
		Compaction: agent.CompactionConfig{
			Enabled: settings.Compaction.Enabled, ContextWindowTokens: settings.Model.ContextWindowTokens,
			ReserveTokens: settings.Compaction.ReserveTokens, KeepRecentTokens: settings.Compaction.KeepRecentTokens,
		},
	}, agentTools)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure agent loop: %w", err), toolSet.Close())
	}
	statePath, err := paths.StateFile()
	if err != nil {
		return nil, errors.Join(fmt.Errorf("resolve state database: %w", err), toolSet.Close())
	}
	store, err := conversation.Open(ctx, statePath)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("open conversation state: %w", err), toolSet.Close())
	}
	toolSnapshot, err := json.Marshal(agentTools)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("encode agent tool config: %w", err), store.Close(), toolSet.Close())
	}
	runConfig, err := json.Marshal(struct {
		API                 string          `json:"api"`
		Input               []string        `json:"input"`
		BaseURL             string          `json:"baseUrl,omitempty"`
		HTTPVersion         string          `json:"httpVersion"`
		Workspace           string          `json:"workspace"`
		Tools               json.RawMessage `json:"tools"`
		RetryEnabled        bool            `json:"retryEnabled"`
		MaxRetries          int             `json:"maxRetries"`
		BaseDelayMS         int             `json:"baseDelayMs"`
		MaxAgentDelayMS     int             `json:"maxAgentDelayMs"`
		InputWindowMS       int             `json:"inputWindowMs"`
		ContextWindowTokens int             `json:"contextWindowTokens"`
		CompactionEnabled   bool            `json:"compactionEnabled"`
		ReserveTokens       int             `json:"reserveTokens"`
		KeepRecentTokens    int             `json:"keepRecentTokens"`
	}{
		API: selected.API, Input: settings.Model.Input,
		BaseURL: selected.BaseURL, HTTPVersion: selected.HTTPVersion,
		Workspace: workspace, Tools: toolSnapshot, RetryEnabled: settings.Retry.Enabled,
		MaxRetries: settings.Retry.MaxRetries, BaseDelayMS: settings.Retry.BaseDelayMS,
		MaxAgentDelayMS:     settings.Retry.MaxAgentDelayMS,
		InputWindowMS:       settings.Gateway.InputWindowMS,
		ContextWindowTokens: settings.Model.ContextWindowTokens,
		CompactionEnabled:   settings.Compaction.Enabled,
		ReserveTokens:       settings.Compaction.ReserveTokens,
		KeepRecentTokens:    settings.Compaction.KeepRecentTokens,
	})
	if err != nil {
		return nil, errors.Join(fmt.Errorf("encode agent run config: %w", err), store.Close(), toolSet.Close())
	}
	messageGateway, err := gateway.NewPersistent(ctx, loop, store, conversation.RunSpec{
		Provider: settings.Model.Provider, Model: settings.Model.ID,
		ReasoningEffort:     settings.Model.ReasoningEffort,
		ContextWindowTokens: settings.Model.ContextWindowTokens,
		SystemPrompt:        systemPrompt, Config: runConfig,
		InputWindow: time.Duration(settings.Gateway.InputWindowMS) * time.Millisecond,
	}, planOutbox)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure message gateway: %w", err), store.Close(), toolSet.Close())
	}
	return &agentRuntime{
		gateway: messageGateway, toolSet: toolSet, store: store, telegramFiles: telegramFiles,
	}, nil
}

func planOutbox(reply conversation.FinalReply) ([]conversation.OutboxChunk, error) {
	if reply.Route.Platform == "telegram" {
		return telegram.PlanOutbox(reply)
	}
	payload, err := json.Marshal(struct {
		Text string `json:"text"`
	}{Text: reply.Text})
	if err != nil {
		return nil, err
	}
	return []conversation.OutboxChunk{{Kind: reply.Kind, Payload: payload}}, nil
}

func (r *agentRuntime) Close() error {
	r.gateway.Close()
	var closeErr error
	if err := r.toolSet.Close(); err != nil {
		closeErr = errors.Join(closeErr, fmt.Errorf("close MCP tools: %w", err))
	}
	if err := r.store.Close(); err != nil {
		closeErr = errors.Join(closeErr, err)
	}
	return closeErr
}
