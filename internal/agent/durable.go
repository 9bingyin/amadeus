package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/felinics/twilight/sdk"
)

type StoredConversation interface {
	PrepareRequest(ctx context.Context) (StoredInput, error)
	WatchInput(afterRevision int64) <-chan struct{}
	InputCurrent(ctx context.Context, inputRevision int64) (bool, error)
	AdmitResponse(ctx context.Context, requestSequence, inputRevision int64) (bool, error)
	CommitStep(ctx context.Context, step *sdk.StepResult, final bool) (StoredStep, error)
}

type StoredInput struct {
	Messages      []sdk.Message
	InputRevision int64
}

type StoredStep struct {
	Sealed bool
}

// RunStored continues a durable conversation from its committed history. The
// store is the authority for pending input, committed steps, and final sealing.
func (l *Loop) RunStored(
	ctx context.Context,
	history []sdk.Message,
	conversation StoredConversation,
) (string, error) {
	started := time.Now()
	if len(history) == 0 {
		return "", errors.New("at least one stored message is required")
	}
	if conversation == nil {
		return "", errors.New("stored conversation is required")
	}
	history = append([]sdk.Message(nil), history...)
	slog.DebugContext(ctx, "Starting stored agent loop",
		"model", l.model.ID,
		"reasoning_effort", l.reasoningEffort,
		"system_prompt", l.systemPrompt,
		"tools", l.tools,
		"input", history,
	)

	requestState := &requestState{conversation: conversation}
	model := modelWithInterrupts(modelWithRequestErrors(l.model), requestState)
	stepIndex := 0
	generation := 0
	retryAttempt := 0
	var totalUsage sdk.Usage
	for {
		generation++
		var result *sdk.GenerateResult
		finalSealed := false
		for {
			input, inputErr := conversation.PrepareRequest(ctx)
			if inputErr != nil {
				return "", fmt.Errorf("prepare messages before request: %w", inputErr)
			}
			requestState.setRevision(input.InputRevision)
			history = append(history, input.Messages...)

			generationCtx, cancelGeneration := context.WithCancel(ctx)
			var prepareErr error
			options := []sdk.GenerateOption{
				sdk.WithModel(model),
				sdk.WithMessages(history),
				sdk.WithTools(l.tools),
				sdk.WithMaxSteps(-1),
				sdk.WithOnStepCommitted(func(callbackCtx context.Context, _ int, step *sdk.StepResult) error {
					if hasIncompleteToolStep(step) {
						return errors.New("cannot commit an incomplete tool step")
					}
					final := isFinalStep(step)
					committed, err := conversation.CommitStep(callbackCtx, step, final)
					if err != nil {
						return err
					}
					history = appendCommittedMessages(history, step.Messages)
					if final {
						finalSealed = committed.Sealed
					}
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
					input, err := conversation.PrepareRequest(generationCtx)
					if err != nil {
						prepareErr = err
						cancelGeneration()
						return nil
					}
					requestState.setRevision(input.InputRevision)
					if len(input.Messages) == 0 {
						return nil
					}
					history = append(history, input.Messages...)
					next := *params
					next.Messages = append(append([]sdk.Message(nil), params.Messages...), input.Messages...)
					return &next
				}),
				sdk.WithOnStep(func(step *sdk.StepResult) *sdk.GenerateParams {
					slog.DebugContext(ctx, "Completed stored agent step",
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
				return "", contextErr
			}
			if errors.Is(generateErr, ErrRequestSuperseded) {
				retryAttempt = 0
				slog.InfoContext(ctx, "Restarting stored agent request with newer input",
					"model", l.model.ID,
					"generation", generation,
				)
				continue
			}
			if !l.retry.Enabled || retryAttempt >= l.retry.MaxRetries || !isRetryableModelRequest(ctx, generateErr) {
				return "", fmt.Errorf("generate response: %w", generateErr)
			}
			retryAttempt++
			delay := retryDelay(l.retry, retryAttempt)
			slog.WarnContext(ctx, "Retrying stored agent request",
				"model", l.model.ID,
				"attempt", retryAttempt,
				"max_attempts", l.retry.MaxRetries,
				"delay", delay,
				"err", generateErr,
			)
			interrupted, err := waitForRetryOrInput(
				ctx, delay, conversation.WatchInput(requestState.revision.Load()),
			)
			if err != nil {
				return "", err
			}
			if interrupted {
				retryAttempt = 0
			}
		}
		if result == nil {
			return "", errors.New("generate response returned no result")
		}
		if finalSealed {
			slog.InfoContext(ctx, "Stored agent response generated",
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
		slog.InfoContext(ctx, "Continuing stored agent run with newer messages",
			"model", l.model.ID,
			"generation", generation,
		)
	}
}

func isFinalStep(step *sdk.StepResult) bool {
	return step.FinishReason != sdk.FinishReasonToolCalls || len(step.ToolResults) == 0
}

func hasIncompleteToolStep(step *sdk.StepResult) bool {
	return step.DeferredToolApproval != nil || len(step.ToolCalls) > 0 && len(step.ToolResults) == 0
}
