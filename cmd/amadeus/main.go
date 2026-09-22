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
	"github.com/9bingyin/amadeus/internal/instance"
	"github.com/9bingyin/amadeus/internal/logging"
	"github.com/9bingyin/amadeus/internal/paths"
	"github.com/9bingyin/amadeus/internal/platform/telegram"
	"github.com/9bingyin/amadeus/internal/search/vector"
	"github.com/9bingyin/amadeus/internal/skills"
	"github.com/9bingyin/amadeus/internal/tools"
	"github.com/9bingyin/amadeus/internal/tools/mcp"
	"github.com/felinics/twilight/provider/openai/embedding"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	started := time.Now()
	err := run(ctx, os.Args[1:])
	if errors.Is(err, instance.ErrAlreadyRunning) {
		slog.InfoContext(ctx, "Amadeus is already running", "err", err)
		return
	}
	if !finishRun(ctx, started, err) {
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
	home, err := paths.Directory()
	if err != nil {
		return err
	}
	lock, err := instance.Acquire(home)
	if err != nil {
		return err
	}
	defer func() {
		if err := lock.Release(); err != nil {
			returnErr = errors.Join(returnErr, err)
		}
	}()

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
	vectors       *vector.Index
	vectorStop    context.CancelFunc
	vectorDone    chan struct{}
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
	statePath, err := paths.StateFile()
	if err != nil {
		return nil, fmt.Errorf("resolve state database: %w", err)
	}
	store, err := conversation.Open(ctx, statePath)
	if err != nil {
		return nil, fmt.Errorf("open conversation state: %w", err)
	}
	chat, ok := settings.Models[settings.Model]
	if !ok {
		return nil, errors.Join(fmt.Errorf("model %q is not configured", settings.Model), store.Close())
	}
	selected, ok := settings.Providers[chat.Provider]
	if !ok {
		return nil, errors.Join(fmt.Errorf("models.%s.provider %q is not configured", settings.Model, chat.Provider), store.Close())
	}
	if selected.API != config.APIOpenAIResponses {
		return nil, errors.Join(
			fmt.Errorf("providers.%s.api %q is not supported", chat.Provider, selected.API),
			store.Close(),
		)
	}
	var vectors *vector.Index
	var searcher tools.SessionSearcher
	var embeddingModelID string
	var embeddingHeaders map[string]string
	if settings.Search.Engine == config.SearchEngineVector {
		embeddingModel, exists := settings.Models[settings.Search.Model]
		if !exists || !embeddingModel.SupportsEmbeddings() {
			return nil, errors.Join(fmt.Errorf("search.model %q is not an embeddings model", settings.Search.Model), store.Close())
		}
		embeddingProvider, exists := settings.Providers[embeddingModel.Provider]
		if !exists {
			return nil, errors.Join(fmt.Errorf("models.%s.provider %q is not configured", settings.Search.Model, embeddingModel.Provider), store.Close())
		}
		if embeddingProvider.API != config.APIOpenAIResponses {
			return nil, errors.Join(
				fmt.Errorf("providers.%s.api %q is not supported", embeddingModel.Provider, embeddingProvider.API),
				store.Close(),
			)
		}
		httpClient, clientErr := agent.HTTPClient(embeddingProvider.HTTPVersion, embeddingProvider.Headers)
		if clientErr != nil {
			return nil, errors.Join(fmt.Errorf("configure session search: %w", clientErr), store.Close())
		}
		embeddingOptions := []embedding.Option{
			embedding.WithAPIKey(embeddingProvider.APIKey),
			embedding.WithHTTPClient(httpClient),
		}
		if embeddingProvider.BaseURL != "" {
			embeddingOptions = append(embeddingOptions, embedding.WithBaseURL(embeddingProvider.BaseURL))
		}
		embedder, embedErr := vector.NewModelEmbedder(embedding.New(embeddingOptions...).EmbeddingModel(embeddingModel.ID))
		if embedErr != nil {
			return nil, errors.Join(fmt.Errorf("configure session search: %w", embedErr), store.Close())
		}
		vectors, err = vector.Open(statePath+".vec", embedder)
		if err != nil {
			return nil, errors.Join(fmt.Errorf("configure session search: %w", err), store.Close())
		}
		searcher = vectors
		embeddingModelID = embeddingModel.ID
		embeddingHeaders = embeddingProvider.Headers
		slog.InfoContext(ctx, "Configured session search", "engine", settings.Search.Engine, "model", embeddingModel.ID)
	} else {
		slog.InfoContext(ctx, "Configured session search", "engine", settings.Search.Engine)
	}
	sessionTools, err := tools.NewSessionTools(store, searcher)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure session tools: %w", err), vectors.Close(), store.Close())
	}
	basicTools = append(basicTools, sessionTools.Tools()...)
	slog.DebugContext(ctx, "Configured local tools", "tools", basicTools)
	globalDirect := false
	if settings.MCP.DirectTools != nil {
		globalDirect = *settings.MCP.DirectTools
	}
	servers := make([]mcp.Server, len(settings.MCP.Servers))
	for index, server := range settings.MCP.Servers {
		direct := mcp.DirectTools{All: globalDirect}
		if server.DirectTools.Set {
			direct = mcp.DirectTools{All: server.DirectTools.All, Names: server.DirectTools.Names}
		}
		servers[index] = mcp.Server{
			Name:         server.Name,
			Transport:    server.Transport,
			URL:          server.URL,
			Headers:      server.Headers,
			Command:      server.Command,
			Args:         server.Args,
			Env:          server.Env,
			DirectTools:  direct,
			IncludeTools: server.IncludeTools,
			ExcludeTools: server.ExcludeTools,
		}
	}
	toolSet, err := mcp.Load(ctx, workspace, servers, basicTools)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure MCP tools: %w", err), vectors.Close(), store.Close())
	}
	agentTools := toolSet.Tools()
	soul, globalAgents, workspaceAgents, err := agent.LoadPromptFiles(home, workspace)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("load prompt files: %w", err), toolSet.Close(), vectors.Close(), store.Close())
	}
	slog.DebugContext(ctx, "Loaded prompt files", "soul", soul != "", "agents", globalAgents != "", "workspace_agents", workspaceAgents != "")
	systemPrompt := agent.BuildSystemPrompt(
		workspace, settings.Telegram.Enabled, toolSet.HasHiddenTools(), skills.SystemPrompt(availableSkills),
		soul, globalAgents, workspaceAgents,
	)
	loop, err := agent.New(agent.Config{
		APIKey:          selected.APIKey,
		Model:           chat.ID,
		BaseURL:         selected.BaseURL,
		HTTPVersion:     selected.HTTPVersion,
		Headers:         selected.Headers,
		ReasoningEffort: chat.ReasoningEffort,
		Input: agent.ModelInput{
			Text:  chat.SupportsText(),
			Image: chat.SupportsImage(),
			File:  chat.SupportsFile(),
		},
		SystemPrompt: systemPrompt,
		Retry: agent.RetryConfig{
			Enabled:       settings.Retry.Enabled,
			MaxRetries:    settings.Retry.MaxRetries,
			BaseDelay:     time.Duration(settings.Retry.BaseDelayMS) * time.Millisecond,
			MaxAgentDelay: time.Duration(settings.Retry.MaxAgentDelayMS) * time.Millisecond,
		},
		Compaction: agent.CompactionConfig{
			Enabled: settings.Compaction.Enabled, ContextWindowTokens: chat.ContextWindowTokens,
			ReserveTokens: settings.Compaction.ReserveTokens, KeepRecentTokens: settings.Compaction.KeepRecentTokens,
		},
	}, agentTools)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure agent loop: %w", err), toolSet.Close(), vectors.Close(), store.Close())
	}
	toolSnapshot, err := json.Marshal(agentTools)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("encode agent tool config: %w", err), store.Close(), vectors.Close(), toolSet.Close())
	}
	runConfig, err := json.Marshal(struct {
		API                 string            `json:"api"`
		Input               []string          `json:"input"`
		BaseURL             string            `json:"baseUrl,omitempty"`
		HTTPVersion         string            `json:"httpVersion"`
		Headers             map[string]string `json:"headers,omitempty"`
		Workspace           string            `json:"workspace"`
		Tools               json.RawMessage   `json:"tools"`
		RetryEnabled        bool              `json:"retryEnabled"`
		MaxRetries          int               `json:"maxRetries"`
		BaseDelayMS         int               `json:"baseDelayMs"`
		MaxAgentDelayMS     int               `json:"maxAgentDelayMs"`
		InputWindowMS       int               `json:"inputWindowMs"`
		ContextWindowTokens int               `json:"contextWindowTokens"`
		CompactionEnabled   bool              `json:"compactionEnabled"`
		ReserveTokens       int               `json:"reserveTokens"`
		KeepRecentTokens    int               `json:"keepRecentTokens"`
		SearchEngine        string            `json:"searchEngine"`
		ModelName           string            `json:"modelName"`
		EmbeddingModel      string            `json:"embeddingModel,omitempty"`
		EmbeddingHeaders    map[string]string `json:"embeddingHeaders,omitempty"`
	}{
		API: selected.API, Input: chat.Input,
		BaseURL: selected.BaseURL, HTTPVersion: selected.HTTPVersion, Headers: selected.Headers,
		Workspace: workspace, Tools: toolSnapshot, RetryEnabled: settings.Retry.Enabled,
		MaxRetries: settings.Retry.MaxRetries, BaseDelayMS: settings.Retry.BaseDelayMS,
		MaxAgentDelayMS:     settings.Retry.MaxAgentDelayMS,
		InputWindowMS:       settings.Gateway.InputWindowMS,
		ContextWindowTokens: chat.ContextWindowTokens,
		CompactionEnabled:   settings.Compaction.Enabled,
		ReserveTokens:       settings.Compaction.ReserveTokens,
		KeepRecentTokens:    settings.Compaction.KeepRecentTokens,
		SearchEngine:        settings.Search.Engine,
		ModelName:           settings.Model,
		EmbeddingModel:      embeddingModelID,
		EmbeddingHeaders:    embeddingHeaders,
	})
	if err != nil {
		return nil, errors.Join(fmt.Errorf("encode agent run config: %w", err), store.Close(), vectors.Close(), toolSet.Close())
	}
	messageGateway, err := gateway.NewPersistent(ctx, loop, store, conversation.RunSpec{
		Provider: chat.Provider, Model: chat.ID,
		ReasoningEffort:     chat.ReasoningEffort,
		ContextWindowTokens: chat.ContextWindowTokens,
		SystemPrompt:        systemPrompt, Config: runConfig,
		InputWindow: time.Duration(settings.Gateway.InputWindowMS) * time.Millisecond,
	}, planReply)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("configure message gateway: %w", err), store.Close(), vectors.Close(), toolSet.Close())
	}
	if vectors != nil {
		messageGateway.SetEmbeddingProgress(func(ctx context.Context, conversationID string) (gateway.EmbeddingProgress, error) {
			total, err := store.CountSearchDocuments(ctx, conversationID)
			if err != nil {
				return gateway.EmbeddingProgress{}, err
			}
			done, phase, err := vectors.ConversationProgress(conversationID)
			if err != nil {
				return gateway.EmbeddingProgress{}, err
			}
			return gateway.EmbeddingProgress{Done: done, Total: total, Phase: gateway.EmbeddingPhase(phase)}, nil
		})
	}
	runtime := &agentRuntime{
		gateway: messageGateway, toolSet: toolSet, store: store, vectors: vectors, telegramFiles: telegramFiles,
	}
	if vectors != nil {
		vectorCtx, stop := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			vectors.Run(vectorCtx, store.ListAllSearchDocuments, store.VectorUpdates(), time.Minute)
		}()
		runtime.vectorStop = stop
		runtime.vectorDone = done
	}
	return runtime, nil
}

func planReply(reply conversation.FinalReply) ([]conversation.ReplyChunk, error) {
	if reply.Route.Platform == "telegram" {
		return telegram.PlanReply(reply)
	}
	payload, err := json.Marshal(struct {
		Text string `json:"text"`
	}{Text: reply.Text})
	if err != nil {
		return nil, err
	}
	return []conversation.ReplyChunk{{Kind: reply.Kind, Payload: payload}}, nil
}

func (r *agentRuntime) Close() error {
	if r.vectorStop != nil {
		r.vectorStop()
	}
	if r.vectorDone != nil {
		<-r.vectorDone
	}
	r.gateway.Close()
	var closeErr error
	if err := r.toolSet.Close(); err != nil {
		closeErr = errors.Join(closeErr, fmt.Errorf("close MCP tools: %w", err))
	}
	if err := r.vectors.Close(); err != nil {
		closeErr = errors.Join(closeErr, err)
	}
	if err := r.store.Close(); err != nil {
		closeErr = errors.Join(closeErr, err)
	}
	return closeErr
}
