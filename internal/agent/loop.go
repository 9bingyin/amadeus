package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/9bingyin/amadeus/internal/tools/codemode"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"

	"github.com/felinics/twilight/provider/openai/responses"
	"github.com/felinics/twilight/sdk"
	"golang.org/x/sys/unix"
)

type ModelInput struct {
	Text  bool
	Image bool
	File  bool
}

func (input ModelInput) normalized() ModelInput {
	if !input.Text && !input.Image && !input.File {
		input.Text = true
	}
	return input
}

type Config struct {
	APIKey          string
	Model           string
	BaseURL         string
	HTTPVersion     string
	Headers         map[string]string
	ReasoningEffort string
	Input           ModelInput
	SystemPrompt    string
	Retry           RetryConfig
	Compaction      CompactionConfig
}

type CompactionConfig struct {
	Enabled             bool
	ContextWindowTokens int
	ReserveTokens       int
	KeepRecentTokens    int
}

type AttachmentKind string

const (
	AttachmentKindImage AttachmentKind = "image"
	AttachmentKindFile  AttachmentKind = "file"
)

type Attachment struct {
	Kind      AttachmentKind
	Data      []byte
	Path      string
	MediaType string
	Filename  string
}

type Message struct {
	Platform        string
	AccountID       string
	ConversationID  string
	ThreadID        string
	SenderID        string
	SourceNamespace string
	SourceEventID   string
	SourcePayload   json.RawMessage
	Text            string
	Attachments     []Attachment
}

// Inbox supplies messages accepted while an agent run is active. Drain is
// called only at complete step boundaries. DrainOrSeal atomically either
// returns newer messages or closes the run to further messages.
type Inbox interface {
	Drain() []Message
	DrainOrSeal() (messages []Message, sealed bool)
}

type closedInbox struct{}

func (closedInbox) Drain() []Message {
	return nil
}

func (closedInbox) DrainOrSeal() ([]Message, bool) {
	return nil, true
}

type Loop struct {
	model           *sdk.Model
	promptMu        sync.RWMutex
	systemPrompt    string
	promptSource    func() (string, error)
	reasoningEffort string
	input           ModelInput
	retry           RetryConfig
	compaction      CompactionConfig
	tools           []toolkit.Tool
}

type requestScopeKey struct{}

type RequestScope struct {
	SessionID      string
	ConversationID string
}

func WithRequestScope(ctx context.Context, scope RequestScope) context.Context {
	return context.WithValue(ctx, requestScopeKey{}, scope)
}

func requestScope(ctx context.Context) RequestScope {
	scope, _ := ctx.Value(requestScopeKey{}).(RequestScope)
	return scope
}

type providerTransport struct {
	base      http.RoundTripper
	userAgent string
	headers   map[string]string
}

func (t providerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header = request.Header.Clone()
	request.Header.Set("User-Agent", t.userAgent)
	headers, err := expandRequestHeaders(t.headers, requestScope(request.Context()))
	if err != nil {
		return nil, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	return t.base.RoundTrip(request)
}

func expandRequestHeaders(headers map[string]string, scope RequestScope) (map[string]string, error) {
	if len(headers) == 0 {
		return nil, nil
	}
	expanded := make(map[string]string, len(headers))
	for name, value := range headers {
		if strings.Contains(value, "{session}") && scope.SessionID == "" {
			return nil, fmt.Errorf("header %s requires a session id", name)
		}
		if strings.Contains(value, "{conversation}") && scope.ConversationID == "" {
			return nil, fmt.Errorf("header %s requires a conversation id", name)
		}
		value = strings.ReplaceAll(value, "{session}", scope.SessionID)
		value = strings.ReplaceAll(value, "{conversation}", scope.ConversationID)
		expanded[name] = value
	}
	return expanded, nil
}

func New(config Config, tools []toolkit.Tool) (*Loop, error) {
	apiKey := strings.TrimSpace(config.APIKey)
	if apiKey == "" {
		return nil, errors.New("openai api key is required")
	}

	modelID := strings.TrimSpace(config.Model)
	if modelID == "" {
		return nil, errors.New("openai model is required")
	}
	if config.Retry.MaxRetries < 0 {
		return nil, errors.New("retry max retries must be non-negative")
	}
	if config.Retry.BaseDelay < 0 {
		return nil, errors.New("retry base delay must be non-negative")
	}
	if config.Retry.MaxAgentDelay < 0 {
		return nil, errors.New("retry max agent delay must be non-negative")
	}
	if err := config.Compaction.validate(); err != nil {
		return nil, err
	}

	httpClient, err := HTTPClient(config.HTTPVersion, config.Headers)
	if err != nil {
		return nil, err
	}
	providerOptions := []responses.Option{
		responses.WithAPIKey(apiKey),
		responses.WithHTTPClient(httpClient),
	}
	if baseURL := strings.TrimSpace(config.BaseURL); baseURL != "" {
		providerOptions = append(providerOptions, responses.WithBaseURL(baseURL))
	}
	provider := responses.New(providerOptions...)
	logged := toolsWithLogging(tools)
	codeTool, err := codemode.New(logged)
	if err != nil {
		return nil, fmt.Errorf("configure codemode: %w", err)
	}
	declared := make([]toolkit.Tool, 0, len(logged)+1)
	for _, tool := range logged {
		if tool.Namespace == "" {
			tool.Description = codemode.ScriptCallDescription(tool)
			declared = append(declared, tool)
		}
	}
	declared = append(declared, toolsWithLogging([]toolkit.Tool{codeTool})...)

	return &Loop{
		model:           provider.ChatModel(modelID),
		systemPrompt:    strings.TrimSpace(config.SystemPrompt),
		reasoningEffort: strings.TrimSpace(config.ReasoningEffort),
		input:           config.Input.normalized(),
		retry:           config.Retry,
		compaction:      config.Compaction,
		tools:           declared,
	}, nil
}

func HTTPClient(version string, headers map[string]string) (*http.Client, error) {
	transport, err := openAITransport(version)
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Transport: providerTransport{
			base:      transport,
			userAgent: buildUserAgent(),
			headers:   headers,
		},
	}, nil
}

func openAITransport(version string) (http.RoundTripper, error) {
	version = strings.ToLower(strings.TrimSpace(version))
	if version == "" || version == "auto" {
		return http.DefaultTransport, nil
	}
	if version != "1.1" {
		return nil, fmt.Errorf("openai HTTP version %q is invalid", version)
	}
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport has unexpected type")
	}
	transport := base.Clone()
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	transport.Protocols = protocols
	return transport, nil
}

func buildUserAgent() string {
	var system unix.Utsname
	release := ""
	if err := unix.Uname(&system); err == nil {
		release = unix.ByteSliceToString(system.Release[:])
	}
	return formatUserAgent(runtime.GOOS, release, runtime.GOARCH)
}

func formatUserAgent(platform, release, architecture string) string {
	if architecture == "amd64" {
		architecture = "x64"
	}
	if release == "" {
		return fmt.Sprintf("amadeus (%s; %s)", platform, architecture)
	}
	return fmt.Sprintf("amadeus (%s %s; %s)", platform, release, architecture)
}

func (l *Loop) SetSystemPromptSource(source func() (string, error)) {
	l.promptMu.Lock()
	l.promptSource = source
	l.promptMu.Unlock()
}

func (l *Loop) reloadSystemPrompt() {
	l.promptMu.RLock()
	source := l.promptSource
	l.promptMu.RUnlock()
	if source == nil {
		return
	}
	prompt, err := source()
	if err != nil {
		slog.Warn("Reload system prompt", "err", err)
		return
	}
	l.promptMu.Lock()
	l.systemPrompt = strings.TrimSpace(prompt)
	l.promptMu.Unlock()
}

func (l *Loop) systemPromptText() string {
	l.promptMu.RLock()
	defer l.promptMu.RUnlock()
	return l.systemPrompt
}

func (l *Loop) Run(ctx context.Context, message Message) (string, error) {
	return l.RunConversation(ctx, []Message{message}, closedInbox{})
}

// RunConversation runs until the model produces a final response and the inbox
// can be atomically sealed. Messages arriving during a tool round are appended
// before the next model call. Messages arriving during a final model call cause
// a new generation without canceling the completed call.
func (l *Loop) RunConversation(ctx context.Context, messages []Message, inbox Inbox) (string, error) {
	started := time.Now()
	if len(messages) == 0 {
		return "", errors.New("at least one agent message is required")
	}
	if inbox == nil {
		return "", errors.New("agent inbox is required")
	}
	l.reloadSystemPrompt()
	history, err := buildUserMessages(messages)
	if err != nil {
		return "", err
	}
	slog.DebugContext(ctx, "Starting agent loop", "model", l.model.ID, "reasoning_effort", l.reasoningEffort,
		"system_prompt", l.systemPromptText(), "tools", l.tools, "messages", messages, "input", history)
	model := modelWithRequestErrors(l.model)
	stepIndex := 0
	retryAttempt := 0
	var totalUsage sdk.Usage
	for {
		pending := inbox.Drain()
		if len(pending) > 0 {
			userMessages, err := buildUserMessages(pending)
			if err != nil {
				return "", err
			}
			history = append(history, userMessages...)
		}
		resolved, err := ResolveFileRefs(limitModelInput(history, l.input))
		if err != nil {
			return "", err
		}
		result, err := model.Generate(ctx, l.request(resolved))
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			if !l.retry.Enabled || retryAttempt >= l.retry.MaxRetries || !isRetryableModelRequest(ctx, err) {
				return "", fmt.Errorf("generate response: %w", err)
			}
			retryAttempt++
			delay := retryDelay(l.retry, retryAttempt)
			slog.WarnContext(ctx, "Retrying agent request", "model", l.model.ID, "attempt", retryAttempt, "delay", delay, "err", err)
			if err := waitForRetry(ctx, delay); err != nil {
				return "", err
			}
			continue
		}
		step, err := toolkit.ExecuteStep(ctx, result, l.tools)
		if err != nil {
			return "", fmt.Errorf("execute tools: %w", err)
		}
		images := extractReadImages(step, l.input.Image)
		history = appendCommittedMessages(history, step.Messages)
		history = append(history, images...)
		totalUsage = addUsage(totalUsage, step.Usage)
		retryAttempt = 0
		slog.DebugContext(ctx, "Completed agent step", "model", l.model.ID, "step_index", stepIndex, "step", step)
		stepIndex++
		if !isFinalStep(step) {
			continue
		}
		pending, sealed := inbox.DrainOrSeal()
		if sealed {
			slog.InfoContext(ctx, "Agent response generated", "model", l.model.ID, "duration", time.Since(started), "steps", stepIndex,
				"input_tokens", totalUsage.InputTokens, "output_tokens", totalUsage.OutputTokens, "total_tokens", totalUsage.TotalTokens, "finish_reason", result.FinishReason)
			return result.Text, nil
		}
		userMessages, err := buildUserMessages(pending)
		if err != nil {
			return "", err
		}
		history = append(history, userMessages...)
	}
}

func (l *Loop) request(messages []sdk.Message) sdk.Request {
	definitions := make([]sdk.ToolDefinition, len(l.tools))
	for index, tool := range l.tools {
		definitions[index] = tool.Definition()
	}
	request := sdk.Request{System: l.systemPromptText(), Messages: messages, Tools: definitions}
	if l.reasoningEffort != "" {
		request.ReasoningEffort = &l.reasoningEffort
	}
	return request
}

func buildUserMessages(messages []Message) ([]sdk.Message, error) {
	result := make([]sdk.Message, 0, len(messages))
	for index, message := range messages {
		userMessage, err := BuildUserMessage(message)
		if err != nil {
			return nil, fmt.Errorf("message %d: %w", index, err)
		}
		result = append(result, userMessage)
	}
	return result, nil
}

func expandReadImages(messages []sdk.Message, acceptsImages bool) []sdk.Message {
	var expanded []sdk.Message
	for _, message := range messages {
		if message.Role != sdk.MessageRoleTool {
			expanded = append(expanded, message)
			continue
		}
		message.Content = append([]sdk.MessagePart(nil), message.Content...)
		step := toolkit.Step{Messages: []sdk.Message{message}}
		images := extractReadImages(&step, acceptsImages)
		expanded = append(expanded, step.Messages[0])
		expanded = append(expanded, images...)
	}
	return expanded
}

func extractReadImages(step *toolkit.Step, acceptsImages bool) []sdk.Message {
	var images []sdk.Message
	for messageIndex := range step.Messages {
		message := &step.Messages[messageIndex]
		for partIndex, part := range message.Content {
			result, ok := part.(sdk.ToolResultPart)
			if !ok || result.ToolName != "read" {
				continue
			}
			if !result.Result.IsJSON() {
				continue
			}
			var image sdk.ImagePart
			if err := json.Unmarshal(result.Result.JSON, &image); err != nil || image.Image == "" || !strings.HasPrefix(image.MediaType, "image/") {
				continue
			}
			result.Result = sdk.TextOutput("Read image file [" + image.MediaType + "]")
			if acceptsImages {
				images = append(images, sdk.UserMessage("Image from read tool:", image))
			} else {
				result.Result = sdk.TextOutput("Read image file [" + image.MediaType + "]. Current model does not support images; image omitted.")
			}
			message.Content[partIndex] = result
		}
	}
	return images
}

func appendCommittedMessages(history, messages []sdk.Message) []sdk.Message {
	for _, message := range messages {
		if message.Usage != nil {
			usage := *message.Usage
			message.Usage = &usage
		}
		history = append(history, message)
	}
	return history
}

func addUsage(total, current sdk.Usage) sdk.Usage {
	total.InputTokens += current.InputTokens
	total.OutputTokens += current.OutputTokens
	total.TotalTokens += current.TotalTokens
	total.ReasoningTokens += current.ReasoningTokens
	total.CachedInputTokens += current.CachedInputTokens
	total.InputTokenDetails.NoCacheTokens += current.InputTokenDetails.NoCacheTokens
	total.InputTokenDetails.CacheReadTokens += current.InputTokenDetails.CacheReadTokens
	total.InputTokenDetails.CacheWriteTokens += current.InputTokenDetails.CacheWriteTokens
	total.InputTokenDetails.CacheWrite5mTokens += current.InputTokenDetails.CacheWrite5mTokens
	total.InputTokenDetails.CacheWrite1hTokens += current.InputTokenDetails.CacheWrite1hTokens
	total.OutputTokenDetails.TextTokens += current.OutputTokenDetails.TextTokens
	total.OutputTokenDetails.ReasoningTokens += current.OutputTokenDetails.ReasoningTokens
	return total
}

func buildUserMessage(message Message) (sdk.Message, error) {
	return BuildUserMessage(message)
}

func BuildUserMessage(message Message) (sdk.Message, error) {
	parts := make([]sdk.MessagePart, 0, 1+len(message.Attachments))
	if text := strings.TrimSpace(message.Text); text != "" {
		parts = append(parts, sdk.TextPart{Text: text})
	}
	for index, attachment := range message.Attachments {
		path := strings.TrimSpace(attachment.Path)
		if path == "" && len(attachment.Data) == 0 {
			return sdk.Message{}, fmt.Errorf("attachment %d path or data is required", index)
		}
		if path != "" {
			if !filepath.IsAbs(path) {
				return sdk.Message{}, fmt.Errorf("attachment %d path must be absolute", index)
			}
			path = filepath.Clean(path)
		}
		switch attachment.Kind {
		case AttachmentKindImage, AttachmentKindFile:
		default:
			return sdk.Message{}, fmt.Errorf("attachment %d has unsupported kind %q", index, attachment.Kind)
		}
		mediaType := strings.TrimSpace(attachment.MediaType)
		if mediaType == "" && attachment.Kind == AttachmentKindFile {
			mediaType = "application/octet-stream"
		}
		parsedMediaType, _, parseErr := mime.ParseMediaType(mediaType)
		if parseErr != nil {
			return sdk.Message{}, fmt.Errorf("attachment %d has invalid media type %q", index, attachment.MediaType)
		}
		mediaType = parsedMediaType
		switch attachment.Kind {
		case AttachmentKindImage:
			if !strings.HasPrefix(mediaType, "image/") {
				return sdk.Message{}, fmt.Errorf("attachment %d has invalid image media type %q", index, attachment.MediaType)
			}
			if path != "" {
				if !IsNativeImageMediaType(mediaType) {
					continue
				}
				parts = append(parts, sdk.ImagePart{Image: FileURL(path), MediaType: mediaType})
				continue
			}
			parts = append(parts, sdk.ImagePart{
				Image:     "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(attachment.Data),
				MediaType: mediaType,
			})
		case AttachmentKindFile:
			filename := strings.TrimSpace(attachment.Filename)
			if filename == "" {
				filename = "attachment"
			}
			if path != "" {
				if !IsNativeFileMediaType(mediaType) {
					continue
				}
				parts = append(parts, sdk.FilePart{Data: FileURL(path), MediaType: mediaType, Filename: filename})
				continue
			}
			parts = append(parts, sdk.FilePart{
				Data:      base64.StdEncoding.EncodeToString(attachment.Data),
				MediaType: mediaType,
				Filename:  filename,
			})
		}
	}
	if len(parts) == 0 {
		return sdk.Message{}, errors.New("message text or attachment is required")
	}
	return sdk.Message{Role: sdk.MessageRoleUser, Content: parts}, nil
}
