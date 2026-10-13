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
	var images []sdk.MessagePart
	for _, call := range result.ToolCalls {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		value, err := execute(ctx, call, tools)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		part := sdk.ToolResultPart{ToolCallID: call.ToolCallID, ToolName: call.ToolName}
		if rich, ok := value.(Result); ok && err == nil {
			part.Result = sdk.TextOutput(rich.Text)
			part.IsError = rich.IsError
			for _, image := range rich.Images {
				images = append(images, image)
			}
		} else if err == nil {
			part.Result, err = Output(value)
		}
		if err != nil {
			part.Result = sdk.TextOutput(err.Error())
			part.IsError = true
		}
		step.ToolResults = append(step.ToolResults, part)
	}
	if len(step.ToolResults) > 0 {
		step.Messages = append(step.Messages, sdk.ToolMessage(step.ToolResults...))
	}
	if len(images) > 0 {
		step.Messages = append(step.Messages, sdk.UserMessage("Images from tool output:", images...))
	}
	return step, nil
}

func execute(ctx context.Context, call sdk.ToolCall, tools []Tool) (any, error) {
	for _, tool := range tools {
		if tool.Name == call.ToolName {
			return Execute(&Context{Context: ctx, ToolCallID: call.ToolCallID, ToolName: call.ToolName}, tool, call.Input)
		}
	}
	return nil, fmt.Errorf("unknown tool %q", call.ToolName)
}

func Execute(ctx *Context, tool Tool, arguments sdk.ToolArguments) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var input any
	if err := arguments.Unmarshal(&input); err != nil {
		return nil, fmt.Errorf("decode %s arguments: %w", tool.Name, err)
	}
	if tool.Execute == nil {
		return nil, fmt.Errorf("tool %q has no executor", tool.Name)
	}
	if tool.Parameters != nil {
		schema, err := tool.Parameters.Resolve(nil)
		if err != nil {
			return nil, fmt.Errorf("resolve %s schema: %w", tool.Name, err)
		}
		if err := schema.Validate(input); err != nil {
			return nil, fmt.Errorf("validate %s arguments: %w", tool.Name, err)
		}
	}
	return tool.Execute(ctx, input)
}
