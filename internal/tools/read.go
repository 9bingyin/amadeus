package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/felinics/twilight/sdk"
	"golang.org/x/image/bmp"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/paths"
)

const (
	readDescription  = "Read text files and images (jpg, png, gif, webp, bmp). Text output is truncated to 2000 lines or 50KB; use offset/limit to continue."
	toolOutputMaxAge = 7 * 24 * time.Hour
)

type readInput struct {
	Path   string `json:"path" jsonschema:"Path to the file to read (relative or absolute)"`
	Offset *int   `json:"offset,omitempty" jsonschema:"Line number to start reading from (1-indexed)"`
	Limit  *int   `json:"limit,omitempty" jsonschema:"Maximum number of lines to read"`
}

func (s *toolSet) readTool() sdk.Tool {
	return sdk.NewTool("read", readDescription, func(ctx *sdk.ToolExecContext, input readInput) (any, error) {
		if err := ctx.Context.Err(); err != nil {
			return nil, err
		}
		path, err := s.resolvePath(input.Path)
		if err != nil {
			return nil, err
		}
		mediaType, err := readImageMediaType(path)
		if err != nil {
			return nil, fmt.Errorf("read %q: %w", input.Path, err)
		}
		if err := ctx.Context.Err(); err != nil {
			return nil, err
		}
		if mediaType == "image/bmp" {
			file, err := os.Open(path)
			if err != nil {
				return nil, fmt.Errorf("read %q: %w", input.Path, err)
			}
			image, decodeErr := bmp.Decode(file)
			file.Close()
			if decodeErr != nil {
				return nil, fmt.Errorf("decode BMP %q: %w", input.Path, decodeErr)
			}
			var encoded bytes.Buffer
			if err := png.Encode(&encoded, image); err != nil {
				return nil, fmt.Errorf("convert BMP %q to PNG: %w", input.Path, err)
			}
			return sdk.ImagePart{Image: "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes()), MediaType: "image/png"}, nil
		}
		if mediaType != "" {
			return sdk.ImagePart{Image: agent.FileURL(path), MediaType: mediaType}, nil
		}
		return s.read(ctx.Context, input)
	})
}

func readImageMediaType(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	var header [32]byte
	n, err := io.ReadFull(file, header[:])
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", err
	}
	data := header[:n]
	switch {
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg", nil
	case len(data) >= 16 && string(data[:8]) == "\x89PNG\r\n\x1a\n" && string(data[12:16]) == "IHDR":
		return "image/png", nil
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		return "image/gif", nil
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp", nil
	case len(data) >= 26 && string(data[:2]) == "BM":
		return "image/bmp", nil
	default:
		return "", nil
	}
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

func LimitHead(text string) (string, error) {
	hasTrailingNewline := strings.HasSuffix(text, "\n")
	lines := strings.Split(text, "\n")
	if hasTrailingNewline && len(lines) > 1 {
		lines = lines[:len(lines)-1]
	}
	content, outputLines, truncatedBy := truncateHead(lines)
	if truncatedBy == "" && hasTrailingNewline && len(content)+1 > maxOutputBytes {
		truncatedBy = "trailing-newline"
	}
	if truncatedBy == "" {
		if hasTrailingNewline {
			return content + "\n", nil
		}
		return content, nil
	}
	if content != "" {
		content += "\n\n"
	}
	if truncatedBy == "trailing-newline" {
		content += fmt.Sprintf("[Showing lines 1-%d of %d (50.0KB limit); trailing newline omitted.]", outputLines, len(lines))
		return content, nil
	}
	path, err := saveToolOutput(text)
	if err != nil {
		return "", err
	}
	if outputLines == 0 {
		content = trimUTF8Head(lines[0], maxOutputBytes)
		content += fmt.Sprintf("\n\n[Line 1 is %.1fKB, exceeds 50.0KB limit. Showing the first 50.0KB. Full output: %s]", float64(len(lines[0]))/1024, path)
		return content, nil
	}
	nextOffset := outputLines + 1
	if truncatedBy == "lines" {
		content += fmt.Sprintf("[Showing lines 1-%d of %d. Use read path=%s offset=%d to continue.]", outputLines, len(lines), path, nextOffset)
		return content, nil
	}
	content += fmt.Sprintf("[Showing lines 1-%d of %d (50.0KB limit). Use read path=%s offset=%d to continue.]", outputLines, len(lines), path, nextOffset)
	return content, nil
}

func MaintainToolOutput(ctx context.Context) {
	cleanToolOutput(ctx)
	ticker := time.NewTicker(toolOutputMaxAge)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanToolOutput(ctx)
		}
	}
}

func cleanToolOutput(ctx context.Context) {
	removed, err := removeOldToolOutput(time.Now())
	if err != nil {
		slog.WarnContext(ctx, "Clean tool output", "err", err)
		return
	}
	if removed > 0 {
		slog.InfoContext(ctx, "Cleaned tool output", "removed", removed)
	}
}

func removeOldToolOutput(now time.Time) (int, error) {
	directory, err := paths.ToolOutputsDirectory()
	if err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read tool output directory: %w", err)
	}
	cutoff := now.Add(-toolOutputMaxAge)
	removed := 0
	var removeErrors []error
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			removeErrors = append(removeErrors, infoErr)
			continue
		}
		if !info.ModTime().Before(cutoff) {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			removeErrors = append(removeErrors, err)
			continue
		}
		removed++
	}
	return removed, errors.Join(removeErrors...)
}

func toolOutputDirectory() (string, error) {
	directory, err := paths.ToolOutputsDirectory()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("create tool output directory: %w", err)
	}
	return directory, nil
}

func saveToolOutput(text string) (string, error) {
	outputDirectory, err := toolOutputDirectory()
	if err != nil {
		return "", err
	}
	file, err := os.CreateTemp(outputDirectory, "mcp-*.log")
	if err != nil {
		return "", fmt.Errorf("create tool output file: %w", err)
	}
	path := file.Name()
	if _, err := file.WriteString(text); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("write tool output file: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("close tool output file: %w", err)
	}
	return path, nil
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

func trimUTF8Head(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}
