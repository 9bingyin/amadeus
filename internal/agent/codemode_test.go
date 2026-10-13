package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	"github.com/felinics/twilight/sdk"
)

func TestLoopExposesLocalToolsAndCodemodeOnly(t *testing.T) {
	local := toolkit.New("echo", "Echo input", func(call *toolkit.Context, input struct {
		Text string `json:"text"`
	}) (any, error) {
		run, ok := ToolRunFrom(call.Context)
		if !ok || run.ChatID != "chat" || !strings.HasPrefix(call.ToolCallID, "code-1/") {
			return nil, errors.New("missing chat scope")
		}
		return input.Text, nil
	})
	remote := toolkit.New("docs__lookup-page", "Look up documentation", func(*toolkit.Context, struct{}) (any, error) {
		return map[string]any{"structuredContent": map[string]any{"answer": "found"}}, nil
	})
	remote.Namespace = "docs"
	loop, err := New(Config{APIKey: "test", Model: "test"}, []toolkit.Tool{local, remote})
	if err != nil {
		t.Fatal(err)
	}
	provider := &providerFunc{generate: func(call int, request sdk.Request) (*sdk.ModelResult, error) {
		if len(request.Tools) != 2 || request.Tools[0].Name != "echo" || request.Tools[1].Name != "codemode" {
			return nil, errors.New("MCP was directly exposed to the model")
		}
		if call == 1 {
			return &sdk.ModelResult{FinishReason: sdk.FinishReasonToolCalls, ToolCalls: []sdk.ToolCall{{
				ToolName: "codemode", ToolCallID: "code-1", Input: toolArguments(map[string]any{
					"code": `return [await tools.echo({text:"scope"}), (await tools.docs__lookup_page({})).structuredContent.answer];`,
				}),
			}}}, nil
		}
		if call == 2 {
			for _, message := range request.Messages {
				for _, part := range message.Content {
					if result, ok := part.(sdk.ToolResultPart); ok && !result.IsError && strings.Contains(result.Result.String(), `["scope","found"]`) {
						return &sdk.ModelResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
					}
				}
			}
		}
		return nil, errors.New("missing script result")
	}}
	loop.model.Provider = provider
	var mu sync.Mutex
	var names []string
	ctx := WithToolRun(t.Context(), ToolRun{Platform: "telegram", ChatID: "chat", Notify: func(_ context.Context, activity ToolActivity) {
		mu.Lock()
		defer mu.Unlock()
		names = append(names, activity.Name)
	}})
	if reply, err := loop.Run(ctx, Message{Text: "look"}); err != nil || reply != "done" {
		t.Fatalf("Run() = %q, %v", reply, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(names, ",") != "codemode,echo,docs__lookup-page" {
		t.Fatalf("tool notifications = %v", names)
	}
}

type codemodeConversation struct {
	*interruptTestConversation
	messages []sdk.Message
}

func (c *codemodeConversation) CommitStep(ctx context.Context, step *toolkit.Step, final bool) (StoredStep, error) {
	c.messages = append(c.messages, step.Messages...)
	return c.interruptTestConversation.CommitStep(ctx, step, final)
}

func TestRunStoredCodemodeImageReachesModel(t *testing.T) {
	t.Setenv("AMADEUS_HOME", t.TempDir())
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "picture.png")
	if err := os.WriteFile(path, data.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	read := toolkit.New("read", "Read image", func(*toolkit.Context, struct{}) (any, error) {
		return sdk.ImagePart{Image: FileURL(path), MediaType: "image/png"}, nil
	})
	loop, err := New(Config{APIKey: "test", Model: "test", Input: ModelInput{Text: true, Image: true}}, []toolkit.Tool{read})
	if err != nil {
		t.Fatal(err)
	}
	loop.model.Provider = &providerFunc{generate: func(call int, request sdk.Request) (*sdk.ModelResult, error) {
		if call == 1 {
			return &sdk.ModelResult{FinishReason: sdk.FinishReasonToolCalls, ToolCalls: []sdk.ToolCall{{
				ToolName: "codemode", ToolCallID: "code-image", Input: toolArguments(map[string]any{"code": `image(await tools.read({}));`}),
			}}}, nil
		}
		if call == 2 {
			for _, message := range request.Messages {
				if message.Role != sdk.MessageRoleUser {
					continue
				}
				for _, part := range message.Content {
					if picture, ok := part.(sdk.ImagePart); ok && strings.HasPrefix(picture.Image, "data:image/png;base64,") {
						return &sdk.ModelResult{Text: "seen", FinishReason: sdk.FinishReasonStop}, nil
					}
				}
			}
		}
		return nil, errors.New("codemode image was not sent to model")
	}}
	conversation := &codemodeConversation{interruptTestConversation: newInterruptTestConversation()}
	if reply, err := loop.RunStored(t.Context(), []sdk.Message{sdk.UserMessage("look")}, conversation); err != nil || reply != "seen" {
		t.Fatalf("RunStored() = %q, %v", reply, err)
	}
	for _, message := range conversation.messages {
		encoded, err := json.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(encoded, []byte("data:image/png;base64,")) {
			t.Fatal("inline image data was persisted rather than the saved file reference")
		}
	}
}
