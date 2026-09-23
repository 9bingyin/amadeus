package memory

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const dreamStateFile = ".dream.json"

type Dream struct {
	Target string
	Text   string
	Limit  int
}

type dreamState struct {
	User   string `json:"user,omitempty"`
	Memory string `json:"memory,omitempty"`
}

func (s *Store) NextDream() (Dream, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadDreamState()
	if err != nil {
		return Dream{}, false, err
	}
	for _, target := range []string{"user", "memory"} {
		file, limit, err := targetFile(target)
		if err != nil {
			return Dream{}, false, err
		}
		text, err := s.read(file)
		if err != nil {
			return Dream{}, false, err
		}
		if !dreamDue(text, limit) || state.seen(target, text) {
			continue
		}
		return Dream{Target: target, Text: text, Limit: limit}, true, nil
	}
	return Dream{}, false, nil
}

func (s *Store) AcceptDream(target, before, replacement string) (bool, error) {
	file, limit, err := targetFile(target)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.read(file)
	if err != nil {
		return false, err
	}
	if current != before {
		return false, nil
	}
	rendered, ok := shorterMemory(replacement, limit, before)
	if !ok {
		return false, s.noteDream(target, before)
	}
	if err := s.write(file, rendered); err != nil {
		return false, err
	}
	if err := s.noteDream(target, before); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) SkipDream(target, before string) error {
	file, _, err := targetFile(target)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.read(file)
	if err != nil {
		return err
	}
	if current != before {
		return nil
	}
	return s.noteDream(target, before)
}

func dreamDue(text string, limit int) bool {
	return limit > 0 && utf8.RuneCountInString(text) >= limit*4/5
}

func shorterMemory(replacement string, limit int, before string) (string, bool) {
	entries := parse(unwrapMemoryList(replacement))
	cleaned := make([]string, 0, len(entries))
	for _, entry := range entries {
		entry, err := cleanEntry(entry)
		if err != nil {
			continue
		}
		cleaned = append(cleaned, entry)
	}
	rendered := render(cleaned)
	if rendered == "" || utf8.RuneCountInString(rendered) > limit {
		return "", false
	}
	if utf8.RuneCountInString(rendered) >= utf8.RuneCountInString(before) {
		return "", false
	}
	return rendered, true
}

func unwrapMemoryList(text string) string {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "```") {
		return text
	}
	rest := text[3:]
	newline := strings.IndexByte(rest, '\n')
	if newline < 0 {
		return text
	}
	rest = strings.TrimSpace(rest[newline+1:])
	rest = strings.TrimSuffix(rest, "```")
	return strings.TrimSpace(rest)
}

func (s dreamState) seen(target, text string) bool {
	key := dreamKey(text)
	switch target {
	case "user":
		return s.User == key
	case "memory":
		return s.Memory == key
	default:
		return false
	}
}

func (s *Store) noteDream(target, text string) error {
	state, err := s.loadDreamState()
	if err != nil {
		return err
	}
	key := dreamKey(text)
	switch target {
	case "user":
		if state.User == key {
			return nil
		}
		state.User = key
	case "memory":
		if state.Memory == key {
			return nil
		}
		state.Memory = key
	default:
		return errors.New("target must be user or memory")
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode dream state: %w", err)
	}
	return s.write(dreamStateFile, string(encoded))
}

func (s *Store) loadDreamState() (dreamState, error) {
	data, err := os.ReadFile(filepath.Join(s.dir, dreamStateFile))
	if errors.Is(err, os.ErrNotExist) {
		return dreamState{}, nil
	}
	if err != nil {
		return dreamState{}, fmt.Errorf("read dream state: %w", err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return dreamState{}, nil
	}
	var state dreamState
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return dreamState{}, fmt.Errorf("read dream state: %w", err)
	}
	return state, nil
}

func dreamKey(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
