package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (s *toolSet) resolvePath(path string) (string, error) {
	resolved, err := ResolvePath(s.cwd, path)
	if err != nil {
		return "", err
	}
	if !s.confined {
		return resolved, nil
	}
	relative, err := filepath.Rel(s.cwd, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q is outside the working directory", path)
	}
	return resolved, nil
}

func ResolvePath(cwd, path string) (string, error) {
	if path == "" {
		return "", errors.New("path is required")
	}

	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	return filepath.Clean(path), nil
}
