package tools

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/felinics/twilight/sdk"
)

const (
	maxOutputLines = 2000
	maxOutputBytes = 50 * 1024
)

type toolSet struct {
	cwd        string
	shell      string
	confined   bool
	mutationMu sync.Mutex
}

func New(cwd string) ([]sdk.Tool, error) {
	if cwd == "" {
		return nil, errors.New("working directory is required")
	}
	absoluteCWD, err := filepath.Abs(cwd)
	if err != nil {
		return nil, fmt.Errorf("resolve working directory: %w", err)
	}
	info, err := os.Stat(absoluteCWD)
	if err != nil {
		return nil, fmt.Errorf("stat working directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("working directory %q is not a directory", absoluteCWD)
	}

	shell, err := exec.LookPath("bash")
	if err != nil {
		return nil, fmt.Errorf("find bash: %w", err)
	}

	set := &toolSet{cwd: absoluteCWD, shell: shell}
	return []sdk.Tool{
		set.readTool(),
		set.editTool(),
		set.bashTool(),
		set.writeTool(),
	}, nil
}

func NewFiles(dir string) ([]sdk.Tool, error) {
	if dir == "" {
		return nil, errors.New("working directory is required")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve working directory: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return nil, fmt.Errorf("stat working directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("working directory %q is not a directory", absolute)
	}
	set := &toolSet{cwd: absolute, confined: true}
	return []sdk.Tool{set.readTool(), set.editTool(), set.writeTool()}, nil
}
