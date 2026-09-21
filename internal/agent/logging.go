package agent

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/felinics/twilight/sdk"
)

func toolsWithLogging(tools []sdk.Tool) []sdk.Tool {
	logged := slices.Clone(tools)
	for index := range logged {
		execute := logged[index].Execute
		if execute == nil {
			continue
		}
		name := logged[index].Name
		logged[index].Execute = func(toolContext *sdk.ToolExecContext, input any) (output any, err error) {
			ctx, callID := toolLogContext(toolContext)
			notifyToolStart(toolContext, name, input)
			started := time.Now()
			slog.DebugContext(ctx, "Starting tool call", "tool", name, "call_id", callID, "input", input)
			executionContext := toolContext
			if toolContext != nil && toolContext.SendProgress != nil {
				clonedContext := *toolContext
				sendProgress := toolContext.SendProgress
				clonedContext.SendProgress = func(content any) {
					slog.DebugContext(ctx, "Tool call progress", "tool", name, "call_id", callID, "content", content)
					sendProgress(content)
				}
				executionContext = &clonedContext
			}
			output, err = execute(executionContext, input)
			attributes := []any{
				"tool", name,
				"call_id", callID,
				"duration", time.Since(started),
				"input", input,
				"output", output,
			}
			if err != nil {
				attributes = append(attributes, "err", err)
				if ctx.Err() != nil {
					slog.DebugContext(ctx, "Tool call canceled", attributes...)
				} else {
					slog.ErrorContext(ctx, "Tool call failed", attributes...)
				}
				return output, err
			}
			slog.DebugContext(ctx, "Completed tool call", attributes...)
			return output, nil
		}
	}
	return logged
}

func notifyToolStart(toolContext *sdk.ToolExecContext, name string, input any) {
	if toolContext == nil || toolContext.Context == nil {
		return
	}
	run, ok := toolContext.Context.Value(toolRunKey{}).(ToolRun)
	if !ok || run.Notify == nil {
		return
	}
	run.Notify(toolContext.Context, ToolActivity{
		RunID: run.ID, Platform: run.Platform, ChatID: run.ChatID, ThreadID: run.ThreadID,
		Name: name, Input: input, InputRevision: inputRevision(toolContext.Context),
	})
}

func toolLogContext(toolContext *sdk.ToolExecContext) (context.Context, string) {
	if toolContext == nil {
		return context.Background(), ""
	}
	ctx := toolContext.Context
	if ctx == nil {
		ctx = context.Background()
	}
	return ctx, toolContext.ToolCallID
}
