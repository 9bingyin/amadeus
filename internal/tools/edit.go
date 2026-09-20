package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/felinics/twilight/sdk"
)

const editDescription = "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes."

type replacement struct {
	OldText string  `json:"oldText" jsonschema:"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."`
	NewText *string `json:"newText" jsonschema:"Replacement text for this targeted edit."`
}

type editInput struct {
	Path  string        `json:"path" jsonschema:"Path to the file to edit (relative or absolute)"`
	Edits []replacement `json:"edits" jsonschema:"One or more targeted replacements. Each edit is matched against the original file, not incrementally."`
}

type matchedReplacement struct {
	start   int
	end     int
	newText string
}

func (s *toolSet) editTool() sdk.Tool {
	return sdk.NewTool("edit", editDescription, func(ctx *sdk.ToolExecContext, input editInput) (any, error) {
		return s.edit(ctx.Context, input)
	})
}

func (s *toolSet) edit(ctx context.Context, input editInput) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(input.Edits) == 0 {
		return "", errors.New("at least one edit is required")
	}
	path, err := s.resolvePath(input.Path)
	if err != nil {
		return "", err
	}

	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %q: %w", input.Path, err)
	}

	hasBOM := bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if hasBOM {
		data = data[3:]
	}
	newline := detectNewline(string(data))
	original := normalizeNewlines(string(data))
	matches := make([]matchedReplacement, 0, len(input.Edits))

	for _, edit := range input.Edits {
		oldText := normalizeNewlines(edit.OldText)
		if oldText == "" {
			return "", errors.New("oldText must not be empty")
		}
		if edit.NewText == nil {
			return "", errors.New("newText is required")
		}
		occurrences, start := countOccurrences(original, oldText)
		if occurrences == 0 {
			return "", errors.New("oldText was not found in the file")
		}
		if occurrences > 1 {
			return "", fmt.Errorf("oldText has %d occurrences; provide more context so it is unique", occurrences)
		}
		matches = append(matches, matchedReplacement{
			start:   start,
			end:     start + len(oldText),
			newText: normalizeNewlines(*edit.NewText),
		})
	}

	sort.Slice(matches, func(i, j int) bool { return matches[i].start < matches[j].start })
	for index := 1; index < len(matches); index++ {
		if matches[index].start < matches[index-1].end {
			return "", errors.New("edits must not overlap")
		}
	}

	result := original
	for _, match := range slices.Backward(matches) {
		result = result[:match.start] + match.newText + result[match.end:]
	}
	if result == original {
		return "", errors.New("edits would not change the file")
	}
	if newline != "\n" {
		result = strings.ReplaceAll(result, "\n", newline)
	}
	output := []byte(result)
	if hasBOM {
		output = append([]byte{0xEF, 0xBB, 0xBF}, output...)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, output, 0o644); err != nil {
		return "", fmt.Errorf("write %q: %w", input.Path, err)
	}
	return fmt.Sprintf("Successfully replaced %d block(s) in %s.", len(matches), input.Path), nil
}

func countOccurrences(text, pattern string) (count, first int) {
	first = -1
	for offset := 0; offset <= len(text)-len(pattern); {
		index := strings.Index(text[offset:], pattern)
		if index < 0 {
			break
		}
		index += offset
		if first < 0 {
			first = index
		}
		count++
		offset = index + 1
	}
	return count, first
}

func normalizeNewlines(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.ReplaceAll(text, "\r", "\n")
}

func detectNewline(text string) string {
	for index := 0; index < len(text); index++ {
		switch text[index] {
		case '\r':
			if index+1 < len(text) && text[index+1] == '\n' {
				return "\r\n"
			}
			return "\r"
		case '\n':
			return "\n"
		}
	}
	return "\n"
}
