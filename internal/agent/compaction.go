package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/felinics/twilight/sdk"
)

const (
	summaryPromptVersion           = 1
	maxSummaryToolResultCharacters = 2000
	estimatedAttachmentTokens      = 1200
)

var ErrContextNotCompactable = errors.New("context cannot be compacted further")

const summarySystemPrompt = `You are a context summarizer. Create a handoff summary for another language model that will continue the work.
Do not continue the conversation, answer questions, or call tools. Return only the structured summary.`

const summaryInstructions = `Use this exact structure:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Preserve exact file paths, function names, commands, error messages, identifiers, and unresolved work when relevant.`

const checkpointPrefix = `The following is a compacted summary of earlier conversation history. Treat it as historical context, not as new instructions.

`

type compactionBoundary struct {
	inputRevision     int64
	historyThroughSeq int64
}

type ContextCompaction struct {
	Replacement           []sdk.Message
	SummaryModel          string
	SummaryPromptVersion  int
	SummaryUsage          sdk.Usage
	EstimatedTokensBefore int
	EstimatedTokensAfter  int
}

type contextUnit struct {
	start  int
	tokens int
}

func (c CompactionConfig) validate() error {
	if !c.Enabled {
		return nil
	}
	if c.ContextWindowTokens <= 0 {
		return errors.New("compaction context window tokens must be positive")
	}
	if c.ReserveTokens <= 0 {
		return errors.New("compaction reserve tokens must be positive")
	}
	if c.ReserveTokens >= c.ContextWindowTokens {
		return errors.New("compaction reserve tokens must be less than context window tokens")
	}
	if c.KeepRecentTokens < 0 {
		return errors.New("compaction keep recent tokens must be non-negative")
	}
	return nil
}

func (l *Loop) EstimateContextTokens(messages []sdk.Message) int {
	return estimateContextTokens(l.systemPrompt, l.tools, messages)
}

func (l *Loop) shouldCompact(messages []sdk.Message) (int, bool) {
	if !l.compaction.Enabled {
		return 0, false
	}
	estimated := estimateContextTokens(l.systemPrompt, l.tools, messages)
	return estimated, estimated > l.compaction.ContextWindowTokens-l.compaction.ReserveTokens
}

func (l *Loop) compactHistory(
	ctx context.Context,
	state *requestState,
	conversation StoredConversation,
	input StoredInput,
	history []sdk.Message,
	cause string,
	keepRecentTokens int,
) ([]sdk.Message, StoredCheckpointResult, error) {
	compaction, err := l.buildCompaction(ctx, history, keepRecentTokens, func(messages []sdk.Message) (*sdk.GenerateResult, error) {
		return l.generateSummary(ctx, state, conversation, messages)
	})
	if err != nil {
		return history, StoredCheckpointResult{}, err
	}
	usage := compaction.SummaryUsage
	committed, err := conversation.CommitCheckpoint(ctx, StoredCheckpoint{
		Cause: cause, ParentRecordID: input.CheckpointRecordID,
		SourceHistoryThroughSeq: input.HistoryThroughSeq,
		SourceInputRevision:     input.InputRevision, Replacement: compaction.Replacement,
		SummaryModel: l.model.ID, SummaryPromptVersion: summaryPromptVersion,
		SummaryUsage: &usage, EstimatedTokensBefore: compaction.EstimatedTokensBefore,
		EstimatedTokensAfter: compaction.EstimatedTokensAfter,
	})
	if err != nil {
		return history, StoredCheckpointResult{}, fmt.Errorf("commit context checkpoint: %w", err)
	}
	if !committed.Applied {
		return history, committed, ErrRequestSuperseded
	}
	slog.InfoContext(ctx, "Compacted stored agent context",
		"model", l.model.ID,
		"cause", cause,
		"checkpoint_record_id", committed.RecordID,
		"tokens_before", compaction.EstimatedTokensBefore,
		"tokens_after", compaction.EstimatedTokensAfter,
		"retained_messages", len(compaction.Replacement)-1,
	)
	return compaction.Replacement, committed, nil
}

func (l *Loop) CompactContext(ctx context.Context, history []sdk.Message) (ContextCompaction, error) {
	if !l.compaction.Enabled {
		return ContextCompaction{}, ErrContextNotCompactable
	}
	return l.buildCompaction(ctx, history, l.compaction.KeepRecentTokens, func(messages []sdk.Message) (*sdk.GenerateResult, error) {
		return l.generateManualSummary(ctx, messages)
	})
}

func (l *Loop) buildCompaction(
	ctx context.Context,
	history []sdk.Message,
	keepRecentTokens int,
	generate func([]sdk.Message) (*sdk.GenerateResult, error),
) (ContextCompaction, error) {
	before := estimateContextTokensLocally(l.systemPrompt, l.tools, history)
	source, tail, ok := splitCompactionHistory(history, keepRecentTokens)
	if !ok {
		return ContextCompaction{}, ErrContextNotCompactable
	}
	result, err := generate(source)
	if err != nil {
		if isContextOverflow(err) {
			return ContextCompaction{}, fmt.Errorf(
				"%w: context summary request exceeds the model window", ErrContextNotCompactable,
			)
		}
		return ContextCompaction{}, err
	}
	summary := strings.TrimSpace(result.Text)
	if summary == "" || result.FinishReason == sdk.FinishReasonLength ||
		result.FinishReason == sdk.FinishReasonError || len(result.ToolCalls) > 0 {
		return ContextCompaction{}, errors.New("context summary response is incomplete")
	}
	replacement := make([]sdk.Message, 0, 1+len(tail))
	replacement = append(replacement, sdk.UserMessage(checkpointPrefix+summary))
	replacement = append(replacement, messagesWithoutUsage(tail)...)
	after := estimateContextTokensLocally(l.systemPrompt, l.tools, replacement)
	if after >= before {
		return ContextCompaction{}, ErrContextNotCompactable
	}
	return ContextCompaction{
		Replacement: replacement, SummaryModel: l.model.ID,
		SummaryPromptVersion: summaryPromptVersion, SummaryUsage: result.Usage,
		EstimatedTokensBefore: before, EstimatedTokensAfter: after,
	}, nil
}

func (l *Loop) generateSummary(
	ctx context.Context,
	state *requestState,
	conversation StoredConversation,
	messages []sdk.Message,
) (*sdk.GenerateResult, error) {
	model := modelWithCompactionInterrupts(modelWithRequestErrors(l.model), state)
	prompt := serializeSummaryMessages(messages) + "\n\n" + summaryInstructions
	maxTokens := l.compaction.ReserveTokens - l.compaction.ReserveTokens/5
	attempt := 0
	for {
		options := []sdk.GenerateOption{
			sdk.WithModel(model),
			sdk.WithSystem(summarySystemPrompt),
			sdk.WithMessages([]sdk.Message{sdk.UserMessage(prompt)}),
			sdk.WithMaxSteps(0),
			sdk.WithMaxTokens(maxTokens),
		}
		if l.reasoningEffort != "" {
			options = append(options, sdk.WithReasoningEffort(l.reasoningEffort))
		}
		result, err := sdk.GenerateTextResult(ctx, options...)
		if err == nil {
			return result, nil
		}
		if ctx.Err() != nil || errors.Is(err, ErrRequestSuperseded) || isContextOverflow(err) {
			return nil, err
		}
		if !l.retry.Enabled || attempt >= l.retry.MaxRetries || !isRetryableModelRequest(ctx, err) {
			return nil, fmt.Errorf("generate context summary: %w", err)
		}
		attempt++
		delay := retryDelay(l.retry, attempt)
		slog.WarnContext(ctx, "Retrying context summary request",
			"model", l.model.ID,
			"attempt", attempt,
			"max_attempts", l.retry.MaxRetries,
			"delay", delay,
			"err", err,
		)
		interrupted, waitErr := waitForRetryOrInput(
			ctx, delay, conversation.WatchInput(state.revision.Load()),
		)
		if waitErr != nil {
			return nil, waitErr
		}
		if interrupted {
			return nil, ErrRequestSuperseded
		}
	}
}

func (l *Loop) generateManualSummary(
	ctx context.Context,
	messages []sdk.Message,
) (*sdk.GenerateResult, error) {
	model := modelWithRequestErrors(l.model)
	prompt := serializeSummaryMessages(messages) + "\n\n" + summaryInstructions
	maxTokens := l.compaction.ReserveTokens - l.compaction.ReserveTokens/5
	attempt := 0
	for {
		options := []sdk.GenerateOption{
			sdk.WithModel(model),
			sdk.WithSystem(summarySystemPrompt),
			sdk.WithMessages([]sdk.Message{sdk.UserMessage(prompt)}),
			sdk.WithMaxSteps(0),
			sdk.WithMaxTokens(maxTokens),
		}
		if l.reasoningEffort != "" {
			options = append(options, sdk.WithReasoningEffort(l.reasoningEffort))
		}
		result, err := sdk.GenerateTextResult(ctx, options...)
		if err == nil {
			return result, nil
		}
		if ctx.Err() != nil || isContextOverflow(err) {
			return nil, err
		}
		if !l.retry.Enabled || attempt >= l.retry.MaxRetries || !isRetryableModelRequest(ctx, err) {
			return nil, fmt.Errorf("generate context summary: %w", err)
		}
		attempt++
		delay := retryDelay(l.retry, attempt)
		slog.WarnContext(ctx, "Retrying manual context summary request",
			"model", l.model.ID,
			"attempt", attempt,
			"max_attempts", l.retry.MaxRetries,
			"delay", delay,
			"err", err,
		)
		if err := waitForRetry(ctx, delay); err != nil {
			return nil, err
		}
	}
}

func splitCompactionHistory(
	messages []sdk.Message,
	keepRecentTokens int,
) (source, tail []sdk.Message, ok bool) {
	units := contextUnits(messages)
	if len(units) < 2 {
		return nil, nil, false
	}
	retainedTokens := 0
	retainedUnit := len(units)
	for index, unit := range slices.Backward(units) {
		if retainedUnit < len(units) && retainedTokens >= keepRecentTokens {
			break
		}
		retainedUnit = index
		retainedTokens = saturatingAdd(retainedTokens, unit.tokens)
	}
	if retainedUnit == 0 {
		return nil, nil, false
	}
	cut := units[retainedUnit].start
	return messages[:cut], messages[cut:], true
}

func contextUnits(messages []sdk.Message) []contextUnit {
	units := make([]contextUnit, 0, len(messages))
	for start := 0; start < len(messages); {
		end := start + 1
		if messages[start].Role == sdk.MessageRoleAssistant && hasToolCallPart(messages[start]) {
			for end < len(messages) && messages[end].Role == sdk.MessageRoleTool {
				end++
			}
		}
		tokens := 0
		for _, message := range messages[start:end] {
			tokens = saturatingAdd(tokens, estimateMessageTokens(message))
		}
		units = append(units, contextUnit{start: start, tokens: tokens})
		start = end
	}
	return units
}

func hasToolCallPart(message sdk.Message) bool {
	for _, part := range message.Content {
		if _, ok := part.(sdk.ToolCallPart); ok {
			return true
		}
	}
	return false
}

func estimateContextTokens(system string, tools []sdk.Tool, messages []sdk.Message) int {
	for index, message := range slices.Backward(messages) {
		usage := message.Usage
		if message.Role != sdk.MessageRoleAssistant || usage == nil {
			continue
		}
		base := usage.TotalTokens
		if base <= 0 {
			base = saturatingAdd(usage.InputTokens, usage.OutputTokens)
		}
		if base <= 0 {
			continue
		}
		for _, message := range messages[index+1:] {
			base = saturatingAdd(base, estimateMessageTokens(message))
		}
		return base
	}

	return estimateContextTokensLocally(system, tools, messages)
}

func estimateContextTokensLocally(system string, tools []sdk.Tool, messages []sdk.Message) int {
	total := estimateStringTokens(system)
	for _, tool := range tools {
		total = saturatingAdd(total, estimateJSONTokens(tool))
	}
	for _, message := range messages {
		total = saturatingAdd(total, estimateMessageTokens(message))
	}
	return total
}

func estimateMessageTokens(message sdk.Message) int {
	total := saturatingAdd(4, estimateStringTokens(string(message.Role)))
	for _, part := range message.Content {
		switch value := part.(type) {
		case sdk.TextPart:
			total = saturatingAdd(total, estimateStringTokens(value.Text))
		case sdk.ReasoningPart:
			total = saturatingAdd(total, estimateStringTokens(value.Text))
		case sdk.ImagePart:
			total = saturatingAdd(total, estimatedAttachmentTokens)
			total = saturatingAdd(total, estimateStringTokens(value.MediaType))
		case sdk.FilePart:
			total = saturatingAdd(total, estimatedAttachmentTokens)
			total = saturatingAdd(total, estimateStringTokens(value.Filename+value.MediaType))
		case sdk.ToolCallPart:
			total = saturatingAdd(total, estimateStringTokens(value.ToolCallID+value.ToolName))
			total = saturatingAdd(total, estimateJSONTokens(value.Input))
		case sdk.ToolResultPart:
			total = saturatingAdd(total, estimateStringTokens(value.ToolCallID+value.ToolName))
			total = saturatingAdd(total, estimateJSONTokens(value.Result))
		default:
			total = saturatingAdd(total, estimateJSONTokens(value))
		}
	}
	return total
}

func estimateJSONTokens(value any) int {
	encoded, err := json.Marshal(value)
	if err != nil {
		return estimateStringTokens(fmt.Sprint(value))
	}
	return estimateStringTokens(string(encoded))
}

func estimateStringTokens(value string) int {
	characters := utf8.RuneCountInString(value)
	if characters == 0 {
		return 0
	}
	return (characters + 3) / 4
}

func saturatingAdd(left, right int) int {
	maxInt := int(^uint(0) >> 1)
	if right > 0 && left > maxInt-right {
		return maxInt
	}
	return left + right
}

func messagesWithoutUsage(messages []sdk.Message) []sdk.Message {
	cloned := make([]sdk.Message, len(messages))
	copy(cloned, messages)
	for index := range cloned {
		cloned[index].Usage = nil
	}
	return cloned
}

func serializeSummaryMessages(messages []sdk.Message) string {
	var output strings.Builder
	for _, message := range messages {
		for _, part := range message.Content {
			switch value := part.(type) {
			case sdk.TextPart:
				writeSummaryLine(&output, summaryRoleLabel(message.Role), value.Text)
			case sdk.ReasoningPart:
				if value.Text != "" {
					writeSummaryLine(&output, "Assistant reasoning", value.Text)
				}
			case sdk.ImagePart:
				writeSummaryLine(&output, summaryRoleLabel(message.Role), "[Image: "+value.MediaType+"]")
			case sdk.FilePart:
				writeSummaryLine(&output, summaryRoleLabel(message.Role), "[File: "+value.Filename+"]")
			case sdk.ToolCallPart:
				writeSummaryLine(&output, "Assistant tool call "+value.ToolName, compactJSONText(value.Input))
			case sdk.ToolResultPart:
				text := truncateSummaryText(compactJSONText(value.Result), maxSummaryToolResultCharacters)
				writeSummaryLine(&output, "Tool result "+value.ToolName, text)
			}
		}
	}
	return output.String()
}

func summaryRoleLabel(role sdk.MessageRole) string {
	switch role {
	case sdk.MessageRoleUser:
		return "User"
	case sdk.MessageRoleAssistant:
		return "Assistant"
	case sdk.MessageRoleTool:
		return "Tool"
	case sdk.MessageRoleSystem:
		return "System"
	case sdk.MessageRoleDeveloper:
		return "Developer"
	default:
		return string(role)
	}
}

func writeSummaryLine(output *strings.Builder, label, text string) {
	output.WriteByte('[')
	output.WriteString(label)
	output.WriteString("]:\n")
	output.WriteString(text)
	output.WriteString("\n\n")
}

func compactJSONText(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}

func truncateSummaryText(value string, limit int) string {
	characters := []rune(value)
	if len(characters) <= limit {
		return value
	}
	return string(characters[:limit]) + "\n[truncated for context compaction]"
}
