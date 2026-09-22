package schedule

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/dop251/goja"
)

type scriptHost struct {
	agent func(context.Context, string) (string, error)
	post  func(string) error
	root  *os.Root
}

func runScript(ctx context.Context, source string, host scriptHost) error {
	vm := goja.New()
	stop := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			vm.Interrupt(ctx.Err())
		case <-stop:
		}
	}()
	defer close(stop)

	bindings := map[string]any{
		"agent": func(prompt string) (string, error) {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			prompt = strings.TrimSpace(prompt)
			if prompt == "" {
				return "", errors.New("prompt is required")
			}
			if host.agent == nil {
				return "", errors.New("agent is unavailable")
			}
			return host.agent(ctx, prompt)
		},
		"post": func(text string) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			return host.post(text)
		},
		"read":  func(path string) (string, error) { return readTaskFile(host.root, path) },
		"write": func(path, content string) error { return writeTaskFile(host.root, path, content) },
	}
	for name, binding := range bindings {
		if err := vm.Set(name, binding); err != nil {
			return fmt.Errorf("set %s: %w", name, err)
		}
	}
	_, err := vm.RunString(source)
	if err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func checkScript(script string) error {
	if strings.TrimSpace(script) == "" {
		return errors.New("script is required")
	}
	if _, err := goja.Compile("task.js", script, false); err != nil {
		return fmt.Errorf("script: %w", err)
	}
	return nil
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
