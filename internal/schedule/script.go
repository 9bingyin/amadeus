package schedule

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/9bingyin/amadeus/internal/tools/codemode"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
)

type scriptHost struct {
	agent func(context.Context, string) (string, error)
	post  func(string) error
	root  *os.Root
	mcp   []toolkit.Tool
}

type scriptAgentInput struct {
	Prompt string `json:"prompt"`
}

type scriptFileInput struct {
	Path string `json:"path"`
}

type scriptWriteInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func runScript(ctx context.Context, source string, host scriptHost) error {
	bindings := []toolkit.Tool{
		toolkit.New("agent", "Ask the scheduled agent to perform a task.", func(call *toolkit.Context, input scriptAgentInput) (any, error) {
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
		toolkit.New("read", "Read a UTF-8 file in this task's directory; missing files return an empty string.", func(_ *toolkit.Context, input scriptFileInput) (any, error) {
			return readTaskFile(host.root, input.Path)
		}),
		toolkit.New("write", "Write a UTF-8 file in this task's directory.", func(_ *toolkit.Context, input scriptWriteInput) (any, error) {
			return nil, writeTaskFile(host.root, input.Path, input.Content)
		}),
	}
	bindings = append(bindings, host.mcp...)
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

func readTaskFile(root *os.Root, path string) (string, error) {
	relative, err := taskPath(path)
	if err != nil {
		return "", err
	}
	file, err := root.Open(relative)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read %q: %w", path, err)
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(file)
	if err != nil {
		return "", fmt.Errorf("read %q: %w", path, err)
	}
	return string(data), nil
}

func writeTaskFile(root *os.Root, path, content string) error {
	relative, err := taskPath(path)
	if err != nil {
		return err
	}
	if dir := filepath.Dir(relative); dir != "." {
		if err := root.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create parent directories for %q: %w", path, err)
		}
	}
	if err := root.WriteFile(relative, []byte(content), 0o600); err != nil {
		return fmt.Errorf("write %q: %w", path, err)
	}
	return nil
}

func taskPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("path is required")
	}
	if filepath.IsAbs(path) {
		return "", fmt.Errorf("path %q is outside the task directory", path)
	}
	clean := filepath.Clean(path)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q is outside the task directory", path)
	}
	return clean, nil
}
