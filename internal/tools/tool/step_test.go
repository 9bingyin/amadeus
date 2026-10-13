package tool

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/felinics/twilight/sdk"
)

func TestExecuteStepPreservesMessagesAndContext(t *testing.T) {
	type input struct {
		Text string `json:"text"`
	}
	type contextKey struct{}
	ctx := context.WithValue(t.Context(), contextKey{}, "scope")
	var order []string
	echo := New("echo", "Echo text", func(ctx *Context, input input) (any, error) {
		if ctx.ToolName != "echo" || ctx.Value(contextKey{}) != "scope" {
			t.Fatalf("tool context = %#v", ctx)
		}
		order = append(order, ctx.ToolCallID)
		return map[string]any{"text": input.Text}, nil
	})
	metadata := sdk.NewProviderMetadata("openai", map[string]string{"itemId": "reasoning-1", "reasoningEncryptedContent": "encrypted"})
	result := sdk.ModelResult{
		Text: "Checking", TextProviderMetadata: sdk.NewProviderMetadata("google", map[string]string{"signature": "text-signature"}),
		ReasoningParts: []sdk.ReasoningPart{{ID: "reasoning-1", ProviderMetadata: metadata}},
		FinishReason:   sdk.FinishReasonToolCalls, Usage: sdk.Usage{TotalTokens: 12},
		ToolCalls: []sdk.ToolCall{
			{ToolCallID: "first", ToolName: "echo", Input: sdk.ParseToolArguments(`{"text":"one"}`), ProviderMetadata: metadata},
			{ToolCallID: "second", ToolName: "echo", Input: sdk.ParseToolArguments(`{"text":"two"}`)},
		},
	}
	step, err := ExecuteStep(ctx, result, []Tool{echo})
	if err != nil {
		t.Fatalf("ExecuteStep() error = %v", err)
	}
	if !reflect.DeepEqual(order, []string{"first", "second"}) || len(step.Messages) != 2 || len(step.ToolResults) != 2 {
		t.Fatalf("step = %#v; order = %v", step, order)
	}
	assistant := step.Messages[0]
	if assistant.Usage.TotalTokens != 12 || len(assistant.Content) != 4 {
		t.Fatalf("assistant = %#v", assistant)
	}
	if reasoning := assistant.Content[0].(sdk.ReasoningPart); !reflect.DeepEqual(reasoning.ProviderMetadata, metadata) {
		t.Fatalf("reasoning metadata = %#v", reasoning.ProviderMetadata)
	}
	if text := assistant.Content[1].(sdk.TextPart); !reflect.DeepEqual(text.ProviderMetadata, result.TextProviderMetadata) {
		t.Fatalf("text metadata = %#v", text.ProviderMetadata)
	}
	if call := assistant.Content[2].(sdk.ToolCallPart); !reflect.DeepEqual(call.ProviderMetadata, metadata) {
		t.Fatalf("call metadata = %#v", call.ProviderMetadata)
	}
	if got := step.ToolResults[0].Result.String(); got != `{"text":"one"}` || step.ToolResults[0].IsError {
		t.Fatalf("first result = %#v", step.ToolResults[0])
	}
}

func TestExecuteStepReturnsToolErrorsToModel(t *testing.T) {
	type input struct {
		Text string `json:"text"`
	}
	for _, test := range []struct {
		name    string
		args    string
		tool    string
		failure string
		want    string
		called  bool
	}{
		{name: "malformed", args: `{"text":`, tool: "echo", want: "not valid JSON"},
		{name: "duplicate keys", args: `{"text":"one","text":"two"}`, tool: "echo", want: "not valid JSON"},
		{name: "missing argument", args: `{}`, tool: "echo", want: "validate echo arguments"},
		{name: "wrong argument type", args: `{"text":1}`, tool: "echo", want: "validate echo arguments"},
		{name: "unknown tool", args: `{}`, tool: "absent", want: "unknown tool"},
		{name: "execution failure", args: `{"text":"one"}`, tool: "echo", failure: "tool failed", want: "tool failed", called: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			called := false
			echo := New("echo", "Echo text", func(*Context, input) (any, error) {
				called = true
				return nil, errors.New(test.failure)
			})
			step, err := ExecuteStep(t.Context(), sdk.ModelResult{
				FinishReason: sdk.FinishReasonToolCalls,
				ToolCalls:    []sdk.ToolCall{{ToolCallID: "call", ToolName: test.tool, Input: sdk.ParseToolArguments(test.args)}},
			}, []Tool{echo})
			if err != nil {
				t.Fatalf("ExecuteStep() error = %v", err)
			}
			part := step.ToolResults[0]
			if !part.IsError || !strings.Contains(part.Result.String(), test.want) || called != test.called {
				t.Fatalf("result = %#v, called = %t", part, called)
			}
		})
	}
}

func TestExecuteStepCancellationStopsRemainingTools(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	calls := 0
	stop := New("stop", "Cancel", func(*Context, struct{}) (any, error) {
		calls++
		cancel()
		return "stopped", nil
	})
	step, err := ExecuteStep(ctx, sdk.ModelResult{ToolCalls: []sdk.ToolCall{
		{ToolCallID: "first", ToolName: "stop"}, {ToolCallID: "second", ToolName: "stop"},
	}}, []Tool{stop})
	if !errors.Is(err, context.Canceled) || step != nil || calls != 1 {
		t.Fatalf("ExecuteStep() = %#v, %v; calls = %d", step, err, calls)
	}
	if step, err := ExecuteStep(ctx, sdk.ModelResult{Text: "final"}, nil); !errors.Is(err, context.Canceled) || step != nil {
		t.Fatalf("cancelled final step = %#v, %v", step, err)
	}
}
