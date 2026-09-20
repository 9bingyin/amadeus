package agent

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/felinics/twilight/provider/openai/responses"
	"github.com/felinics/twilight/sdk"
	"golang.org/x/sys/unix"
)

type Config struct {
	APIKey          string
	Model           string
	BaseURL         string
	ReasoningEffort string
	SystemPrompt    string
}

type AttachmentKind string

const (
	AttachmentKindImage AttachmentKind = "image"
	AttachmentKindFile  AttachmentKind = "file"
)

type Attachment struct {
	Kind      AttachmentKind
	Data      []byte
	MediaType string
	Filename  string
}

type Message struct {
	Platform       string
	ConversationID string
	SenderID       string
	Text           string
	Attachments    []Attachment
}

type Loop struct {
	model           *sdk.Model
	systemPrompt    string
	reasoningEffort string
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

	httpClient := &http.Client{
		Transport: userAgentTransport{
			base:      http.DefaultTransport,
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
		tools:           toolsWithLogging(tools),
	}, nil
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
	started := time.Now()
	userMessage, err := buildUserMessage(message)
	if err != nil {
		slog.ErrorContext(ctx, "Build agent message", "message", message, "err", err)
		return "", err
	}
	slog.DebugContext(ctx, "Starting agent loop",
		"model", l.model.ID,
		"reasoning_effort", l.reasoningEffort,
		"system_prompt", l.systemPrompt,
		"tools", l.tools,
		"message", message,
		"input", userMessage,
	)

	stepIndex := 0
	options := []sdk.GenerateOption{
		sdk.WithModel(l.model),
		sdk.WithMessages([]sdk.Message{userMessage}),
		sdk.WithTools(l.tools),
		sdk.WithMaxSteps(-1),
		sdk.WithOnStep(func(step *sdk.StepResult) *sdk.GenerateParams {
			slog.DebugContext(ctx, "Completed agent step", "model", l.model.ID, "step_index", stepIndex, "step", step)
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

	result, err := sdk.GenerateTextResult(ctx, options...)
	if err != nil {
		attributes := []any{"model", l.model.ID, "duration", time.Since(started), "err", err}
		if ctx.Err() != nil {
			slog.DebugContext(ctx, "Agent loop canceled", attributes...)
		} else {
			slog.ErrorContext(ctx, "Agent loop failed", attributes...)
		}
		return "", fmt.Errorf("generate response: %w", err)
	}
	slog.DebugContext(ctx, "Completed agent loop", "model", l.model.ID, "duration", time.Since(started), "result", result)
	slog.InfoContext(ctx, "Agent response generated",
		"model", l.model.ID,
		"duration", time.Since(started),
		"steps", len(result.Steps),
		"input_tokens", result.Usage.InputTokens,
		"output_tokens", result.Usage.OutputTokens,
		"total_tokens", result.Usage.TotalTokens,
		"finish_reason", result.FinishReason,
	)
	return result.Text, nil
}

func buildUserMessage(message Message) (sdk.Message, error) {
	parts := make([]sdk.MessagePart, 0, 1+len(message.Attachments))
	if text := strings.TrimSpace(message.Text); text != "" {
		parts = append(parts, sdk.TextPart{Text: text})
	}
	for index, attachment := range message.Attachments {
		if len(attachment.Data) == 0 {
			return sdk.Message{}, fmt.Errorf("attachment %d data is required", index)
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
			parts = append(parts, sdk.ImagePart{
				Image:     "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(attachment.Data),
				MediaType: mediaType,
			})
		case AttachmentKindFile:
			filename := strings.TrimSpace(attachment.Filename)
			if filename == "" {
				filename = "attachment"
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
