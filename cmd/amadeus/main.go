package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/config"
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
		return service.Run(ctx)
	}
	return errors.New("no message platform is enabled")
}

type agentRuntime struct {
	gateway *gateway.Gateway
	toolSet *mcp.Set
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
	workspace, err := paths.WorkspaceDirectory(settings.Workspace)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace: %w", err)
	}
	slog.InfoContext(ctx, "Configured agent workspace", "path", workspace)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return nil, fmt.Errorf("create workspace %q: %w", workspace, err)
	}
	basicTools, err := tools.New(workspace)
	if err != nil {
		return nil, fmt.Errorf("configure tools: %w", err)
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
	loop, err := agent.New(agent.Config{
		APIKey:          settings.OpenAI.APIKey,
		Model:           settings.OpenAI.Model,
		BaseURL:         settings.OpenAI.BaseURL,
		ReasoningEffort: settings.OpenAI.ReasoningEffort,
		SystemPrompt:    skills.SystemPrompt(availableSkills),
	}, toolSet.Tools())
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure agent loop: %w", err), toolSet.Close())
	}
	messageGateway, err := gateway.New(loop)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure message gateway: %w", err), toolSet.Close())
	}
	return &agentRuntime{gateway: messageGateway, toolSet: toolSet}, nil
}

func (r *agentRuntime) Close() error {
	if err := r.toolSet.Close(); err != nil {
		return fmt.Errorf("close MCP tools: %w", err)
	}
	return nil
}
