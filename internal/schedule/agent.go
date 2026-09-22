package schedule

import (
	"context"
	"errors"
	"strings"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/tools"
	"github.com/felinics/twilight/sdk"
)

type AgentRequest struct {
	Config    agent.Config
	Directory string
	Prompt    string
	Post      func(string) error
	MCP       []sdk.Tool
	HiddenMCP bool
}

func RunAgent(ctx context.Context, request AgentRequest) (string, error) {
	prompt := strings.TrimSpace(request.Prompt)
	if prompt == "" {
		return "", errors.New("prompt is required")
	}
	if request.Post == nil {
		return "", errors.New("post is required")
	}
	fileTools, err := tools.NewFiles(request.Directory)
	if err != nil {
		return "", err
	}
	taskTools := make([]sdk.Tool, 0, len(fileTools)+1+len(request.MCP))
	taskTools = append(taskTools, fileTools...)
	taskTools = append(taskTools, postTool(request.Post))
	taskTools = append(taskTools, request.MCP...)

	config := request.Config
	config.SystemPrompt = agent.BuildSchedulePrompt(request.Directory, request.HiddenMCP)
	loop, err := agent.New(config, taskTools)
	if err != nil {
		return "", err
	}
	return loop.Run(ctx, agent.Message{Text: prompt})
}

func postTool(post func(string) error) sdk.Tool {
	return sdk.NewTool(
		"post",
		"Post a report of what happened to the main assistant through the local platform. Call it when there is something to report.",
		func(toolContext *sdk.ToolExecContext, input postInput) (any, error) {
			if toolContext != nil && toolContext.Context != nil {
				if err := toolContext.Err(); err != nil {
					return "", err
				}
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
