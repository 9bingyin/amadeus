package memory

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/felinics/twilight/sdk"
)

const (
	userFile    = "USER.md"
	memoryFile  = "MEMORY.md"
	userLimit   = 1400
	memoryLimit = 2200

	toolText = "Save a durable fact for a later run. target user is who the user is. target memory is a fact worth remembering later. action is add, replace, or remove. replace and remove find one entry by a unique substring. The write is stored immediately and appears in <user> or <memory> on the next run. Save preferences, corrections, and facts worth remembering. Leave task progress and one-off notes out."
)

type Store struct {
	dir string
	mu  sync.Mutex
}

type memoryInput struct {
	Action  string `json:"action" jsonschema:"add, replace, or remove"`
	Target  string `json:"target" jsonschema:"user or memory"`
	Content string `json:"content,omitempty" jsonschema:"The fact to save. Required for add and replace."`
	OldText string `json:"oldText,omitempty" jsonschema:"Unique substring of the entry to replace or remove."`
}

func Open(dir string) (*Store, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("memory directory is required")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve memory directory: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return nil, fmt.Errorf("stat memory directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("memory directory %q is not a directory", absolute)
	}
	return &Store{dir: absolute}, nil
}

func (s *Store) Load() (user, facts string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, err = s.read(userFile)
	if err != nil {
		return "", "", err
	}
	facts, err = s.read(memoryFile)
	if err != nil {
		return "", "", err
	}
	return user, facts, nil
}

func (s *Store) Tool() sdk.Tool {
	return sdk.NewTool("memory", toolText, func(_ *sdk.ToolExecContext, input memoryInput) (any, error) {
		return s.Apply(input.Target, input.Action, input.Content, input.OldText)
	})
}

func (s *Store) Apply(target, action, content, oldText string) (string, error) {
	file, limit, err := targetFile(target)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.entries(file)
	if err != nil {
		return "", err
	}
	switch strings.TrimSpace(action) {
	case "add":
		entry, cleanErr := cleanEntry(content)
		if cleanErr != nil {
			return "", cleanErr
		}
		if containsEntry(entries, entry) {
			return formatSaved(target, entries), nil
		}
		entries = append(entries, entry)
	case "replace":
		entry, cleanErr := cleanEntry(content)
		if cleanErr != nil {
			return "", cleanErr
		}
		index, findErr := findEntry(entries, oldText)
		if findErr != nil {
			return "", findErr
		}
		entries[index] = entry
	case "remove":
		index, findErr := findEntry(entries, oldText)
		if findErr != nil {
			return "", findErr
		}
		entries = append(entries[:index], entries[index+1:]...)
	default:
		return "", errors.New("action must be add, replace, or remove")
	}
	rendered := render(entries)
	if utf8.RuneCountInString(rendered) > limit {
		return "", fmt.Errorf("%s is full (%d characters); replace or remove an entry first", strings.TrimSpace(target), limit)
	}
	if err := s.write(file, rendered); err != nil {
		return "", err
	}
	return formatSaved(target, entries), nil
}

func (s *Store) read(name string) (string, error) {
	entries, err := s.entries(name)
	if err != nil {
		return "", err
	}
	return render(entries), nil
}

func (s *Store) entries(name string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	return parse(string(data)), nil
}

func (s *Store) write(name, rendered string) error {
	path := filepath.Join(s.dir, name)
	body := ""
	if rendered != "" {
		body = rendered + "\n"
	}
	temp, err := os.CreateTemp(s.dir, "."+name+".")
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	tempName := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempName)
		}
	}()
	if _, err := temp.WriteString(body); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	cleanup = false
	return nil
}

func targetFile(target string) (string, int, error) {
	switch strings.TrimSpace(target) {
	case "user":
		return userFile, userLimit, nil
	case "memory":
		return memoryFile, memoryLimit, nil
	default:
		return "", 0, errors.New("target must be user or memory")
	}
}

func cleanEntry(content string) (string, error) {
	content = strings.Join(strings.Fields(content), " ")
	if content == "" {
		return "", errors.New("content is required")
	}
	return content, nil
}

func containsEntry(entries []string, entry string) bool {
	return slices.Contains(entries, entry)
}

func findEntry(entries []string, oldText string) (int, error) {
	oldText = strings.TrimSpace(oldText)
	if oldText == "" {
		return 0, errors.New("oldText is required")
	}
	match := -1
	for index, entry := range entries {
		if strings.Contains(entry, oldText) {
			if match >= 0 {
				return 0, errors.New("oldText matches more than one entry")
			}
			match = index
		}
	}
	if match < 0 {
		return 0, errors.New("oldText does not match an entry")
	}
	return match, nil
}

func parse(data string) []string {
	var entries []string
	for line := range strings.SplitSeq(data, "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "- ")
		line = strings.TrimPrefix(line, "* ")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		entries = append(entries, line)
	}
	return entries
}

func render(entries []string) string {
	if len(entries) == 0 {
		return ""
	}
	lines := make([]string, len(entries))
	for index, entry := range entries {
		lines[index] = "- " + entry
	}
	return strings.Join(lines, "\n")
}

func formatSaved(target string, entries []string) string {
	rendered := render(entries)
	if rendered == "" {
		return "saved " + strings.TrimSpace(target)
	}
	return "saved " + strings.TrimSpace(target) + "\n" + rendered
}
