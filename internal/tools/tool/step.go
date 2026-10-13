package tool

import (
	"context"
	"fmt"

	"github.com/felinics/twilight/sdk"
)

type Step struct {
	Text            string
	FinishReason    sdk.FinishReason
	RawFinishReason string
	Usage           sdk.Usage
	Response        sdk.ResponseMetadata
	ToolCalls       []sdk.ToolCall
	ToolResults     []sdk.ToolResultPart
	Messages        []sdk.Message
}

func ExecuteStep(ctx context.Context, result sdk.ModelResult, tools []Tool) (*Step, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	step := &Step{
		Text:         result.Text,
		FinishReason: result.FinishReason, RawFinishReason: result.RawFinishReason,
		Usage: result.Usage, Response: result.Response, ToolCalls: result.ToolCalls,
	}
	var parts []sdk.MessagePart
	for _, reasoning := range result.ReasoningParts {
		parts = append(parts, reasoning)
	}
	if len(result.ReasoningParts) == 0 && result.Reasoning != "" {
		parts = append(parts, sdk.ReasoningPart{Text: result.Reasoning})
	}
	if result.Text != "" {
		parts = append(parts, sdk.TextPart{Text: result.Text, ProviderMetadata: result.TextProviderMetadata})
	}
	for _, call := range result.ToolCalls {
		parts = append(parts, sdk.ToolCallPart{
			ToolCallID: call.ToolCallID, ToolName: call.ToolName,
			Input: call.Input, ProviderMetadata: call.ProviderMetadata,
		})
	}
	step.Messages = []sdk.Message{{Role: sdk.MessageRoleAssistant, Content: parts, Usage: &step.Usage}}
	for _, call := range result.ToolCalls {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		output, err := execute(ctx, call, tools)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		part := sdk.ToolResultPart{ToolCallID: call.ToolCallID, ToolName: call.ToolName, Result: output}
		if err != nil {
			part.Result = sdk.TextOutput(err.Error())
			part.IsError = true
		}
		step.ToolResults = append(step.ToolResults, part)
	}
	if len(step.ToolResults) > 0 {
		step.Messages = append(step.Messages, sdk.ToolMessage(step.ToolResults...))
	}
	return step, nil
}

func execute(ctx context.Context, call sdk.ToolCall, tools []Tool) (sdk.ToolOutput, error) {
	var input any
	if err := call.Input.Unmarshal(&input); err != nil {
		return sdk.ToolOutput{}, fmt.Errorf("decode %s arguments: %w", call.ToolName, err)
	}
	for _, tool := range tools {
		if tool.Name != call.ToolName {
			continue
		}
		if tool.Execute == nil {
			return sdk.ToolOutput{}, fmt.Errorf("tool %q has no executor", call.ToolName)
		}
		if tool.Parameters != nil {
			schema, err := tool.Parameters.Resolve(nil)
			if err != nil {
				return sdk.ToolOutput{}, fmt.Errorf("resolve %s schema: %w", call.ToolName, err)
			}
			if err := schema.Validate(input); err != nil {
				return sdk.ToolOutput{}, fmt.Errorf("validate %s arguments: %w", call.ToolName, err)
			}
		}
		value, err := tool.Execute(&Context{Context: ctx, ToolCallID: call.ToolCallID, ToolName: call.ToolName}, input)
		if err != nil {
			return sdk.ToolOutput{}, err
		}
		return Output(value)
	}
	return sdk.ToolOutput{}, fmt.Errorf("unknown tool %q", call.ToolName)
}
