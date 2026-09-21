package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/felinics/twilight/sdk"
)

const writeDescription = "Write a file in the agent workspace. Creates the file if it does not exist, overwrites if it does, and creates parent directories."

type writeInput struct {
	Path    string  `json:"path" jsonschema:"Path to the file to write (relative or absolute)"`
	Content *string `json:"content" jsonschema:"Content to write to the file"`
}

func (s *toolSet) writeTool() sdk.Tool {
	return sdk.NewTool("write", writeDescription, func(ctx *sdk.ToolExecContext, input writeInput) (any, error) {
		return s.write(ctx.Context, input)
	})
}

func (s *toolSet) write(ctx context.Context, input writeInput) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	path, err := s.resolvePath(input.Path)
	if err != nil {
		return "", err
	}
	if input.Content == nil {
		return "", errors.New("content is required")
	}

	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("create parent directories for %q: %w", input.Path, err)
	}
	if err := os.WriteFile(path, []byte(*input.Content), 0o644); err != nil {
		return "", fmt.Errorf("write %q: %w", input.Path, err)
	}
	return fmt.Sprintf("Successfully wrote to %s", input.Path), nil
}
