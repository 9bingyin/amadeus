package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/felinics/twilight/sdk"
)

const dreamMaxTokens = 4096

const dreamSystemPrompt = `You shorten one Amadeus memory list. Merge duplicates and drop facts that are outdated. Keep facts that are still useful. Return only a Markdown bullet list, one fact per line. Do not add facts, call tools, or explain the edit.`

func (l *Loop) RewriteMemory(ctx context.Context, target, text string, limit int) (string, error) {
	model := modelWithRequestErrors(l.model)
	prompt := dreamUserPrompt(target, text, limit)
	attempt := 0
	for {
		options := []sdk.GenerateOption{
			sdk.WithModel(model),
			sdk.WithSystem(dreamSystemPrompt),
			sdk.WithMessages([]sdk.Message{sdk.UserMessage(prompt)}),
			sdk.WithMaxSteps(0),
			sdk.WithMaxTokens(dreamMaxTokens),
		}
		if l.reasoningEffort != "" {
			options = append(options, sdk.WithReasoningEffort(l.reasoningEffort))
		}
		result, err := sdk.GenerateTextResult(ctx, options...)
		if err != nil {
			if ctx.Err() != nil || isContextOverflow(err) {
				return "", err
			}
			if !l.retry.Enabled || attempt >= l.retry.MaxRetries || !isRetryableModelRequest(ctx, err) {
				return "", fmt.Errorf("rewrite memory: %w", err)
			}
			attempt++
			delay := retryDelay(l.retry, attempt)
			slog.WarnContext(ctx, "Retrying memory rewrite",
				"model", l.model.ID,
				"target", target,
				"attempt", attempt,
				"max_attempts", l.retry.MaxRetries,
				"delay", delay,
				"err", err,
			)
			if err := waitForRetry(ctx, delay); err != nil {
				return "", err
			}
			continue
		}
		rewritten := strings.TrimSpace(result.Text)
		if rewritten == "" || result.FinishReason == sdk.FinishReasonLength ||
			result.FinishReason == sdk.FinishReasonError || len(result.ToolCalls) > 0 {
			return "", errors.New("memory rewrite is incomplete")
		}
		return rewritten, nil
	}
}

func dreamUserPrompt(target, text string, limit int) string {
	subject := "who the user is"
	if target == "memory" {
		subject = "durable memory"
	}
	return fmt.Sprintf("This list is %s. Keep it under %d characters, and make it shorter than the list below.\n\n%s", subject, limit, text)
}
