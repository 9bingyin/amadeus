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
	"time"

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
	systemPrompt    string
	reasoningEffort string
	input           ModelInput
	retry           RetryConfig
	compaction      CompactionConfig
	tools           []sdk.Tool
}

type userAgentTransport struct {
	base      http.RoundTripper
	userAgent string
}

func (t userAgentTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header = request.Header.Clone()
	request.Header.Set("User-Agent", t.userAgent)
	return t.base.RoundTrip(request)
}

func New(config Config, tools []sdk.Tool) (*Loop, error) {
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

	transport, err := openAITransport(config.HTTPVersion)
	if err != nil {
		return nil, err
	}
	httpClient := &http.Client{
		Transport: userAgentTransport{
			base:      transport,
			userAgent: buildUserAgent(),
		},
	}
	providerOptions := []responses.Option{
		responses.WithAPIKey(apiKey),
		responses.WithHTTPClient(httpClient),
	}
	if baseURL := strings.TrimSpace(config.BaseURL); baseURL != "" {
		providerOptions = append(providerOptions, responses.WithBaseURL(baseURL))
	}
	provider := responses.New(providerOptions...)

	return &Loop{
		model:           provider.ChatModel(modelID),
		systemPrompt:    strings.TrimSpace(config.SystemPrompt),
		reasoningEffort: strings.TrimSpace(config.ReasoningEffort),
		input:           config.Input.normalized(),
		retry:           config.Retry,
		compaction:      config.Compaction,
		tools:           toolsWithLogging(tools),
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

	history, err := buildUserMessages(messages)
	if err != nil {
		slog.ErrorContext(ctx, "Build agent messages", "messages", messages, "err", err)
		return "", err
	}
	slog.DebugContext(ctx, "Starting agent loop",
		"model", l.model.ID,
		"reasoning_effort", l.reasoningEffort,
		"system_prompt", l.systemPrompt,
		"tools", l.tools,
		"messages", messages,
		"input", history,
	)

	model := modelWithRequestErrors(l.model)
	stepIndex := 0
	generation := 0
	retryAttempt := 0
	var totalUsage sdk.Usage
	for {
		generation++
		var result *sdk.GenerateResult
		for {
			pending := inbox.Drain()
			if len(pending) > 0 {
				userMessages, buildErr := buildUserMessages(pending)
				if buildErr != nil {
					return "", buildErr
				}
				history = append(history, userMessages...)
			}

			resolvedHistory, resolveErr := ResolveFileRefs(limitModelInput(history, l.input))
			if resolveErr != nil {
				return "", resolveErr
			}
			generationCtx, cancelGeneration := context.WithCancel(ctx)
			var prepareErr error
			options := []sdk.GenerateOption{
				sdk.WithModel(model),
				sdk.WithMessages(resolvedHistory),
				sdk.WithTools(l.tools),
				sdk.WithMaxSteps(-1),
				sdk.WithOnStepCommitted(func(_ context.Context, _ int, step *sdk.StepResult) error {
					history = appendCommittedMessages(history, step.Messages)
					totalUsage = addUsage(totalUsage, step.Usage)
					if retryAttempt > 0 {
						slog.InfoContext(ctx, "Agent request retry succeeded",
							"model", l.model.ID,
							"attempt", retryAttempt,
						)
						retryAttempt = 0
					}
					return nil
				}),
				sdk.WithPrepareStep(func(params *sdk.GenerateParams) *sdk.GenerateParams {
					pending := inbox.Drain()
					if len(pending) == 0 {
						return nil
					}
					userMessages, buildErr := buildUserMessages(pending)
					if buildErr != nil {
						prepareErr = buildErr
						cancelGeneration()
						return nil
					}
					history = append(history, userMessages...)
					next := *params
					combined := append(append([]sdk.Message(nil), params.Messages...), userMessages...)
					resolved, resolveErr := ResolveFileRefs(limitModelInput(combined, l.input))
					if resolveErr != nil {
						prepareErr = resolveErr
						cancelGeneration()
						return nil
					}
					next.Messages = resolved
					return &next
				}),
				sdk.WithOnStep(func(step *sdk.StepResult) *sdk.GenerateParams {
					slog.DebugContext(ctx, "Completed agent step",
						"model", l.model.ID,
						"generation", generation,
						"step_index", stepIndex,
						"step", step,
					)
					stepIndex++
					return nil
				}),
			}
			if l.systemPrompt != "" {
				options = append(options, sdk.WithSystem(l.systemPrompt))
			}
			if l.reasoningEffort != "" {
				options = append(options, sdk.WithReasoningEffort(l.reasoningEffort))
			}

			var generateErr error
			result, generateErr = sdk.GenerateTextResult(generationCtx, options...)
			cancelGeneration()
			if prepareErr != nil {
				return "", prepareErr
			}
			if generateErr == nil {
				break
			}
			if contextErr := ctx.Err(); contextErr != nil {
				slog.DebugContext(ctx, "Agent loop canceled",
					"model", l.model.ID,
					"duration", time.Since(started),
					"err", contextErr,
				)
				return "", contextErr
			}
			if !l.retry.Enabled || retryAttempt >= l.retry.MaxRetries || !isRetryableModelRequest(ctx, generateErr) {
				slog.ErrorContext(ctx, "Agent loop failed",
					"model", l.model.ID,
					"duration", time.Since(started),
					"err", generateErr,
				)
				return "", fmt.Errorf("generate response: %w", generateErr)
			}

			retryAttempt++
			delay := retryDelay(l.retry, retryAttempt)
			slog.WarnContext(ctx, "Retrying agent request",
				"model", l.model.ID,
				"attempt", retryAttempt,
				"max_attempts", l.retry.MaxRetries,
				"delay", delay,
				"err", generateErr,
			)
			if err := waitForRetry(ctx, delay); err != nil {
				slog.DebugContext(ctx, "Agent request retry canceled",
					"model", l.model.ID,
					"attempt", retryAttempt,
					"err", err,
				)
				return "", err
			}
		}
		if result == nil {
			return "", errors.New("generate response returned no result")
		}
		slog.DebugContext(ctx, "Completed agent generation",
			"model", l.model.ID,
			"generation", generation,
			"duration", time.Since(started),
			"result", result,
		)

		pending, sealed := inbox.DrainOrSeal()
		if !sealed && (len(result.ToolCalls) > 0 || result.DeferredToolApproval != nil) {
			return "", errors.New("cannot continue agent run after an incomplete tool step")
		}
		if sealed {
			slog.InfoContext(ctx, "Agent response generated",
				"model", l.model.ID,
				"duration", time.Since(started),
				"generations", generation,
				"steps", stepIndex,
				"input_tokens", totalUsage.InputTokens,
				"output_tokens", totalUsage.OutputTokens,
				"total_tokens", totalUsage.TotalTokens,
				"finish_reason", result.FinishReason,
			)
			return result.Text, nil
		}
		userMessages, buildErr := buildUserMessages(pending)
		if buildErr != nil {
			return "", buildErr
		}
		history = append(history, userMessages...)
		slog.InfoContext(ctx, "Continuing agent run with newer messages",
			"model", l.model.ID,
			"generation", generation,
			"message_count", len(pending),
		)
	}
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
