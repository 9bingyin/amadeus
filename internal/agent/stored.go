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
	CommitCheckpoint(ctx context.Context, checkpoint StoredCheckpoint) (StoredCheckpointResult, error)
	CommitStep(ctx context.Context, step *sdk.StepResult, final bool) (StoredStep, error)
	RecordAbortedRequest(ctx context.Context, inputRevision int64) (sdk.Message, error)
}

type StoredInput struct {
	Messages           []sdk.Message
	InputRevision      int64
	HistoryThroughSeq  int64
	CheckpointRecordID string
}

type StoredCheckpoint struct {
	Cause                   string
	ParentRecordID          string
	SourceHistoryThroughSeq int64
	SourceInputRevision     int64
	Replacement             []sdk.Message
	SummaryModel            string
	SummaryPromptVersion    int
	SummaryUsage            *sdk.Usage
	EstimatedTokensBefore   int
	EstimatedTokensAfter    int
}

type StoredCheckpointResult struct {
	RecordID string
	Applied  bool
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
	ctx = withInputRevision(ctx)
	l.reloadSystemPrompt()
	slog.DebugContext(ctx, "Starting stored agent loop",
		"model", l.model.ID,
		"reasoning_effort", l.reasoningEffort,
		"system_prompt", l.systemPromptText(),
		"tools", l.tools,
		"input", history,
	)

	requestState := &requestState{conversation: conversation}
	model := modelWithInterrupts(modelWithRequestErrors(l.model), requestState)
	stepIndex := 0
	generation := 0
	retryAttempt := 0
	var lastCompactionBoundary compactionBoundary
	hasCompactionBoundary := false
	compactedSourceKey := ""
	overflowRecoveryRevision := int64(0)
	hasOverflowRecoveryRevision := false
	overflowRecoveryUsed := false
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
			if noteInputRevision(ctx, input.InputRevision) {
				notifyProgressReset(ctx, input.InputRevision)
			}
			history = append(history, input.Messages...)

			boundary := compactionBoundary{
				inputRevision: input.InputRevision, historyThroughSeq: input.HistoryThroughSeq,
			}
			if !hasOverflowRecoveryRevision || boundary.inputRevision != overflowRecoveryRevision {
				overflowRecoveryRevision = boundary.inputRevision
				hasOverflowRecoveryRevision = true
				overflowRecoveryUsed = false
			}
			maxTailTokens := l.maxTailTokens()
			if estimated, compact := l.shouldCompact(history); compact &&
				(!hasCompactionBoundary || boundary != lastCompactionBoundary) &&
				!repeatedCompactionPrefix(history, l.compaction.KeepRecentTokens, maxTailTokens, compactedSourceKey) {
				lastCompactionBoundary = boundary
				hasCompactionBoundary = true
				compacted, checkpoint, compactErr := l.compactHistory(
					ctx, requestState, conversation, input, history,
					"threshold", l.compaction.KeepRecentTokens,
				)
				if compactErr == nil {
					history = compacted
					input.CheckpointRecordID = checkpoint.RecordID
					compactedSourceKey = prefixKeyAfterCompaction(history, l.compaction.KeepRecentTokens, maxTailTokens)
				} else if errors.Is(compactErr, ErrRequestSuperseded) {
					retryAttempt = 0
					slog.InfoContext(ctx, "Restarting context compaction with newer input",
						"model", l.model.ID,
						"generation", generation,
					)
					continue
				} else if errors.Is(compactErr, ErrContextNotCompactable) {
					slog.WarnContext(ctx, "Context exceeds automatic compaction threshold but has no smaller checkpoint",
						"model", l.model.ID,
						"estimated_tokens", estimated,
						"context_window_tokens", l.compaction.ContextWindowTokens,
					)
				} else {
					return "", requestFailureAt(input.InputRevision, compactErr)
				}
			}

			resolvedHistory, resolveErr := ResolveFileRefs(limitModelInput(expandReadImages(history, l.input.Image), l.input))
			if resolveErr != nil {
				return "", requestFailureAt(input.InputRevision, resolveErr)
			}
			options := []sdk.GenerateOption{
				sdk.WithModel(model),
				sdk.WithMessages(resolvedHistory),
				sdk.WithTools(l.tools),
				sdk.WithMaxSteps(1),
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
			if prompt := l.systemPromptText(); prompt != "" {
				options = append(options, sdk.WithSystem(prompt))
			}
			if l.reasoningEffort != "" {
				options = append(options, sdk.WithReasoningEffort(l.reasoningEffort))
			}

			var generateErr error
			result, generateErr = sdk.GenerateTextResult(ctx, options...)
			if generateErr == nil {
				break
			}
			if contextErr := ctx.Err(); contextErr != nil {
				return "", contextErr
			}
			if errors.Is(generateErr, ErrRequestSuperseded) {
				aborted, err := conversation.RecordAbortedRequest(ctx, input.InputRevision)
				if err != nil {
					return "", fmt.Errorf("record interrupted model request: %w", err)
				}
				history = append(history, aborted)
				retryAttempt = 0
				slog.InfoContext(ctx, "Restarting stored agent request with newer input",
					"model", l.model.ID,
					"generation", generation,
				)
				continue
			}
			if isContextOverflow(generateErr) && l.compaction.Enabled && !overflowRecoveryUsed {
				overflowRecoveryUsed = true
				compacted, _, compactErr := l.compactHistory(
					ctx, requestState, conversation, input, history,
					"overflow", l.compaction.KeepRecentTokens,
				)
				if errors.Is(compactErr, ErrRequestSuperseded) {
					retryAttempt = 0
					continue
				}
				if compactErr != nil {
					return "", requestFailureAt(
						input.InputRevision,
						fmt.Errorf("recover context overflow: %w", compactErr),
					)
				}
				history = compacted
				lastCompactionBoundary = boundary
				hasCompactionBoundary = true
				compactedSourceKey = prefixKeyAfterCompaction(history, l.compaction.KeepRecentTokens, maxTailTokens)
				retryAttempt = 0
				slog.InfoContext(ctx, "Retrying stored agent request after context compaction",
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
	if step.DeferredToolApproval != nil || len(step.ToolCalls) != len(step.ToolResults) {
		return true
	}
	calls := make(map[string]int, len(step.ToolCalls))
	for _, call := range step.ToolCalls {
		calls[call.ToolCallID]++
	}
	for _, result := range step.ToolResults {
		if calls[result.ToolCallID] == 0 {
			return true
		}
		calls[result.ToolCallID]--
	}
	return false
}
