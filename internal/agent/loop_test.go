package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/felinics/twilight/sdk"
)

func TestToolsWithLoggingRecordsRawInputAndOutput(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	var progress any
	tools := toolsWithLogging([]sdk.Tool{{
		Name: "echo",
		Execute: func(toolContext *sdk.ToolExecContext, input any) (any, error) {
			toolContext.SendProgress("raw-progress")
			return map[string]any{"raw": "raw-output", "input": input}, nil
		},
	}})
	_, err := tools[0].Execute(&sdk.ToolExecContext{
		Context: t.Context(), ToolCallID: "call-1", ToolName: "echo",
		SendProgress: func(content any) {
			progress = content
		},
	}, map[string]any{"raw": "raw-input"})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if progress != "raw-progress" {
		t.Fatalf("progress = %#v", progress)
	}
	for _, want := range []string{"Starting tool call", "Tool call progress", "Completed tool call", "call-1", "raw-input", "raw-progress", "raw-output"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("logs = %q, want containing %q", logs.String(), want)
		}
	}
}

func TestToolsWithLoggingRecordsCancellationAsDebug(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	ctx, cancel := context.WithCancel(t.Context())
	tools := toolsWithLogging([]sdk.Tool{{
		Name: "cancel",
		Execute: func(_ *sdk.ToolExecContext, _ any) (any, error) {
			cancel()
			return nil, context.Canceled
		},
	}})
	_, err := tools[0].Execute(&sdk.ToolExecContext{Context: ctx}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Execute() error = %v, want canceled", err)
	}
	if !strings.Contains(logs.String(), "Tool call canceled") || strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Fatalf("logs = %q", logs.String())
	}
}

func TestNewValidatesConfig(t *testing.T) {
	tests := []struct {
		name    string
		config  Config
		wantErr string
	}{
		{
			name:    "missing api key",
			config:  Config{Model: "gpt-5-mini"},
			wantErr: "openai api key is required",
		},
		{
			name:    "missing model",
			config:  Config{APIKey: "test-key"},
			wantErr: "openai model is required",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := New(test.config, nil)
			if err == nil || err.Error() != test.wantErr {
				t.Fatalf("New() error = %v, want %q", err, test.wantErr)
			}
		})
	}
}

func TestNewUsesOpenAIResponses(t *testing.T) {
	loop, err := New(Config{APIKey: "test-key", Model: "gpt-5-mini"}, nil)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if loop.model.Provider.Name() != "openai-responses" {
		t.Fatalf("provider = %q, want %q", loop.model.Provider.Name(), "openai-responses")
	}
}

func TestLoopUsesOpenAIOptions(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/responses" {
			t.Errorf("request path = %q, want %q", request.URL.Path, "/responses")
		}
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("authorization = %q, want bearer token", request.Header.Get("Authorization"))
		}
		if request.UserAgent() != buildUserAgent() {
			t.Errorf("user agent = %q, want %q", request.UserAgent(), buildUserAgent())
		}
		var body struct {
			Instructions string `json:"instructions"`
			Reasoning    *struct {
				Effort string `json:"effort"`
			} `json:"reasoning"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if body.Reasoning == nil || body.Reasoning.Effort != "high" {
			t.Errorf("reasoning = %#v, want effort high", body.Reasoning)
		}
		if body.Instructions != "system instructions" {
			t.Errorf("instructions = %q", body.Instructions)
		}
		w.Header().Set("Content-Type", "application/json")
		response := `{
			"id":"response-1",
			"created_at":1700000000,
			"model":"test-model",
			"output":[{
				"type":"message",
				"id":"message-1",
				"role":"assistant",
				"content":[{"type":"output_text","text":"done","annotations":[]}]
			}]
		}`
		if _, err := w.Write([]byte(response)); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	loop, err := New(Config{
		APIKey:          "test-key",
		Model:           "test-model",
		BaseURL:         server.URL,
		ReasoningEffort: "high",
		SystemPrompt:    "system instructions",
	}, nil)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := loop.Run(t.Context(), Message{Text: "hello"})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result != "done" {
		t.Fatalf("result text = %q, want %q", result, "done")
	}
	for _, want := range []string{"hello", "done", "system instructions", "response-1", "Completed agent step"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("logs = %q, want containing %q", logs.String(), want)
		}
	}
}

func TestFormatUserAgent(t *testing.T) {
	got := formatUserAgent("linux", "6.18.44", "amd64")
	want := "amadeus (linux 6.18.44; x64)"
	if got != want {
		t.Fatalf("formatUserAgent() = %q, want %q", got, want)
	}
}

func TestLoopExecutesToolsWithoutStepLimit(t *testing.T) {
	const toolRounds = 10

	provider := &scriptedProvider{t: t, toolRounds: toolRounds}
	model := &sdk.Model{ID: "test-model", Provider: provider, Type: sdk.ModelTypeChat}

	var toolCalls atomic.Int32
	type echoInput struct {
		Text string `json:"text"`
	}
	echo := sdk.NewTool("echo", "echo input text", func(_ *sdk.ToolExecContext, input echoInput) (any, error) {
		toolCalls.Add(1)
		return input.Text, nil
	})

	loop := &Loop{
		model: model,
		tools: []sdk.Tool{echo},
	}
	result, err := loop.Run(t.Context(), Message{Text: "use the echo tool"})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result != "done" {
		t.Fatalf("result text = %q, want %q", result, "done")
	}
	if provider.calls != toolRounds+1 {
		t.Fatalf("provider calls = %d, want %d", provider.calls, toolRounds+1)
	}
	if toolCalls.Load() != toolRounds {
		t.Fatalf("tool calls = %d, want %d", toolCalls.Load(), toolRounds)
	}
}

func TestBuildUserMessageWithAttachments(t *testing.T) {
	message, err := buildUserMessage(Message{
		Text: " describe these ",
		Attachments: []Attachment{
			{Kind: AttachmentKindImage, Data: []byte("image"), MediaType: "image/png", Filename: "image.png"},
			{Kind: AttachmentKindFile, Data: []byte("pdf"), MediaType: "application/pdf", Filename: "report.pdf"},
		},
	})
	if err != nil {
		t.Fatalf("buildUserMessage() error = %v", err)
	}
	if message.Role != sdk.MessageRoleUser || len(message.Content) != 3 {
		t.Fatalf("message = %#v", message)
	}
	text, ok := message.Content[0].(sdk.TextPart)
	if !ok || text.Text != "describe these" {
		t.Fatalf("text part = %#v", message.Content[0])
	}
	image, ok := message.Content[1].(sdk.ImagePart)
	if !ok || image.Image != "data:image/png;base64,aW1hZ2U=" || image.MediaType != "image/png" {
		t.Fatalf("image part = %#v", message.Content[1])
	}
	file, ok := message.Content[2].(sdk.FilePart)
	if !ok || file.Data != "cGRm" || file.MediaType != "application/pdf" || file.Filename != "report.pdf" {
		t.Fatalf("file part = %#v", message.Content[2])
	}
}

func TestBuildUserMessageAcceptsAttachmentOnly(t *testing.T) {
	message, err := buildUserMessage(Message{Attachments: []Attachment{{
		Kind: AttachmentKindFile, Data: []byte("file"),
	}}})
	if err != nil {
		t.Fatalf("buildUserMessage() error = %v", err)
	}
	if len(message.Content) != 1 {
		t.Fatalf("content = %#v", message.Content)
	}
	file, ok := message.Content[0].(sdk.FilePart)
	if !ok || file.MediaType != "application/octet-stream" || file.Filename != "attachment" {
		t.Fatalf("file part = %#v", message.Content[0])
	}
}

func TestBuildUserMessageRejectsInvalidContent(t *testing.T) {
	tests := []struct {
		name    string
		message Message
		wantErr string
	}{
		{name: "empty", message: Message{}, wantErr: "message text or attachment is required"},
		{
			name: "empty attachment", message: Message{Attachments: []Attachment{{Kind: AttachmentKindFile}}},
			wantErr: "attachment 0 data is required",
		},
		{
			name:    "invalid image type",
			message: Message{Attachments: []Attachment{{Kind: AttachmentKindImage, Data: []byte("data"), MediaType: "application/pdf"}}},
			wantErr: `invalid image media type "application/pdf"`,
		},
		{
			name:    "unsupported kind",
			message: Message{Attachments: []Attachment{{Kind: "audio", Data: []byte("data")}}},
			wantErr: `unsupported kind "audio"`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := buildUserMessage(test.message)
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("buildUserMessage() error = %v, want containing %q", err, test.wantErr)
			}
		})
	}
}

type scriptedProvider struct {
	t          *testing.T
	calls      int
	toolRounds int
}

func (p *scriptedProvider) Name() string {
	return "scripted"
}

func (p *scriptedProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}

func (p *scriptedProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}

func (p *scriptedProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}

func (p *scriptedProvider) DoGenerate(_ context.Context, params sdk.GenerateParams) (*sdk.GenerateResult, error) {
	p.calls++
	if len(params.Tools) != 1 || params.Tools[0].Name != "echo" {
		p.t.Fatalf("tools = %#v, want echo tool", params.Tools)
	}
	if p.calls > 1 && !hasToolResult(params.Messages, "hello") {
		p.t.Fatalf("messages do not contain expected tool result: %#v", params.Messages)
	}
	if p.calls <= p.toolRounds {
		return &sdk.GenerateResult{
			FinishReason: sdk.FinishReasonToolCalls,
			ToolCalls: []sdk.ToolCall{
				{
					ToolCallID: fmt.Sprintf("call-%d", p.calls),
					ToolName:   "echo",
					Input:      map[string]any{"text": "hello"},
				},
			},
		}, nil
	}
	if p.calls == p.toolRounds+1 {
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	}
	return nil, errors.New("unexpected model call")
}

func (p *scriptedProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

func hasToolResult(messages []sdk.Message, want string) bool {
	for _, message := range messages {
		if message.Role != sdk.MessageRoleTool {
			continue
		}
		for _, part := range message.Content {
			result, ok := part.(sdk.ToolResultPart)
			if ok && result.Result == want {
				return true
			}
		}
	}
	return false
}
