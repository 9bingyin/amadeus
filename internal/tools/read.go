package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/felinics/twilight/sdk"
)

const readDescription = "Read the contents of a text file. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete."

type readInput struct {
	Path   string `json:"path" jsonschema:"Path to the file to read (relative or absolute)"`
	Offset *int   `json:"offset,omitempty" jsonschema:"Line number to start reading from (1-indexed)"`
	Limit  *int   `json:"limit,omitempty" jsonschema:"Maximum number of lines to read"`
}

func (s *toolSet) readTool() sdk.Tool {
	return sdk.NewTool("read", readDescription, func(ctx *sdk.ToolExecContext, input readInput) (any, error) {
		return s.read(ctx.Context, input)
	})
}

func (s *toolSet) read(ctx context.Context, input readInput) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	path, err := s.resolvePath(input.Path)
	if err != nil {
		return "", err
	}
	if input.Offset != nil && *input.Offset < 1 {
		return "", errors.New("offset must be at least 1")
	}
	if input.Limit != nil && *input.Limit < 1 {
		return "", errors.New("limit must be at least 1")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %q: %w", input.Path, err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	text := string(data)
	hasTrailingNewline := strings.HasSuffix(text, "\n")
	lines := strings.Split(text, "\n")
	if hasTrailingNewline && len(lines) > 1 {
		lines = lines[:len(lines)-1]
	}
	start := 0
	if input.Offset != nil {
		start = *input.Offset - 1
	}
	if start >= len(lines) {
		return "", fmt.Errorf("offset %d is beyond end of file (%d lines total)", start+1, len(lines))
	}

	end := len(lines)
	if input.Limit != nil && *input.Limit < end-start {
		end = start + *input.Limit
	}
	selected := lines[start:end]
	content, outputLines, truncatedBy := truncateHead(selected)
	if truncatedBy == "" && end == len(lines) && hasTrailingNewline && len(content)+1 > maxOutputBytes {
		truncatedBy = "trailing-newline"
	}

	if truncatedBy != "" {
		if content != "" {
			content += "\n\n"
		}
		if outputLines == 0 {
			lineSize := len(selected[0])
			return fmt.Sprintf("[Line %d is %.1fKB, exceeds 50.0KB limit.]", start+1, float64(lineSize)/1024), nil
		}
		lastLine := start + outputLines
		if truncatedBy == "trailing-newline" {
			content += fmt.Sprintf("[Showing lines %d-%d of %d (50.0KB limit); trailing newline omitted.]", start+1, lastLine, len(lines))
			return content, nil
		}
		nextOffset := lastLine + 1
		if truncatedBy == "lines" {
			content += fmt.Sprintf("[Showing lines %d-%d of %d. Use offset=%d to continue.]", start+1, lastLine, len(lines), nextOffset)
		} else {
			content += fmt.Sprintf("[Showing lines %d-%d of %d (50.0KB limit). Use offset=%d to continue.]", start+1, lastLine, len(lines), nextOffset)
		}
		return content, nil
	}

	if end < len(lines) {
		remaining := len(lines) - end
		content += fmt.Sprintf("\n\n[%d more lines in file. Use offset=%d to continue.]", remaining, end+1)
	} else if hasTrailingNewline {
		content += "\n"
	}
	return content, nil
}

func truncateHead(lines []string) (content string, outputLines int, truncatedBy string) {
	selected := make([]string, 0, min(len(lines), maxOutputLines))
	bytesUsed := 0
	for index, line := range lines {
		if len(selected) == maxOutputLines {
			return strings.Join(selected, "\n"), len(selected), "lines"
		}
		lineBytes := len(line)
		if index > 0 {
			lineBytes++
		}
		if bytesUsed+lineBytes > maxOutputBytes {
			return strings.Join(selected, "\n"), len(selected), "bytes"
		}
		selected = append(selected, line)
		bytesUsed += lineBytes
	}
	return strings.Join(selected, "\n"), len(selected), ""
}
