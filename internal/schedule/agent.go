package schedule

import (
	"context"
	"errors"
	"slices"
	"strings"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"

	"github.com/9bingyin/amadeus/internal/agent"
)

type AgentRequest struct {
	Config    agent.Config
	Directory string
	Prompt    string
	Post      func(string) error
	Tools     []toolkit.Tool
}

func RunAgent(ctx context.Context, request AgentRequest) (string, error) {
	prompt := strings.TrimSpace(request.Prompt)
	if prompt == "" {
		return "", errors.New("prompt is required")
	}
	if request.Post == nil {
		return "", errors.New("post is required")
	}
	taskTools := append(slices.Clone(request.Tools), postTool(request.Post))

	config := request.Config
	config.SystemPrompt = agent.BuildSchedulePrompt(config.SystemPrompt, request.Directory)
	loop, err := agent.New(config, taskTools)
	if err != nil {
		return "", err
	}
	return loop.Run(ctx, agent.Message{Text: prompt})
}

func postTool(post func(string) error) toolkit.Tool {
	return toolkit.New(
		"post",
		"Post a report of what happened to the main assistant through the local platform. Call it when there is something to report.",
		func(toolContext *toolkit.Context, input postInput) (any, error) {
			if toolContext != nil && toolContext.Context != nil {
				if err := toolContext.Err(); err != nil {
					return "", err
				}
			}
			if post == nil {
				return nil, errors.New("post is unavailable")
			}
			if err := post(input.Text); err != nil {
				return "", err
			}
			return "posted", nil
		},
	)
}

type postInput struct {
	Text string `json:"text" jsonschema:"What happened, for the main assistant to pass on to the user."`
}
