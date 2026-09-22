package paths

import (
	"fmt"
	"os"
	"path/filepath"
)

const directoryName = ".amadeus"

func Directory() (string, error) {
	if configured := os.Getenv("AMADEUS_HOME"); configured != "" {
		directory, err := filepath.Abs(configured)
		if err != nil {
			return "", fmt.Errorf("resolve AMADEUS_HOME %q: %w", configured, err)
		}
		return directory, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home directory: %w", err)
	}
	if !filepath.IsAbs(home) {
		return "", fmt.Errorf("user home directory %q is not absolute", home)
	}
	return filepath.Join(home, directoryName), nil
}

func ConfigFile() (string, error) {
	directory, err := Directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "config.json"), nil
}

func StateFile() (string, error) {
	directory, err := Directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "state.db"), nil
}

func JobsDirectory() (string, error) {
	directory, err := Directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "jobs"), nil
}

func SkillsDirectory() (string, error) {
	directory, err := Directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "skills"), nil
}

func ToolOutputsDirectory() (string, error) {
	directory, err := Directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, ".tool-outputs"), nil
}

func AttachmentsDirectory() (string, error) {
	directory, err := Directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "attachments"), nil
}

func WorkspaceDirectory(configured string) (string, error) {
	directory, err := Directory()
	if err != nil {
		return "", err
	}
	if configured == "" {
		return filepath.Join(directory, "workspace"), nil
	}
	if filepath.IsAbs(configured) {
		return filepath.Clean(configured), nil
	}
	return filepath.Join(directory, configured), nil
}
