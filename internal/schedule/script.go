package schedule

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/9bingyin/amadeus/internal/tools/codemode"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
)

type scriptHost struct {
	agent func(context.Context, string) (string, error)
	post  func(string) error
	tools []toolkit.Tool
}

type scriptAgentInput struct {
	Prompt string `json:"prompt"`
}

func runScript(ctx context.Context, source string, host scriptHost) error {
	bindings := append(slices.Clone(host.tools),
		toolkit.New("agent", "Ask the scheduled agent to perform a task with the main assistant's tools and workspace.", func(call *toolkit.Context, input scriptAgentInput) (any, error) {
			prompt := strings.TrimSpace(input.Prompt)
			if prompt == "" {
				return nil, errors.New("prompt is required")
			}
			if host.agent == nil {
				return nil, errors.New("agent is unavailable")
			}
			return host.agent(call.Context, prompt)
		}),
		postTool(host.post),
	)
	result, err := codemode.Run(ctx, source, bindings)
	if err != nil {
		return err
	}
	if result.IsError {
		return errors.New(result.Text)
	}
	return nil
}

func checkScript(ctx context.Context, script string) error {
	if strings.TrimSpace(script) == "" {
		return errors.New("script is required")
	}
	return codemode.Validate(ctx, script)
}
