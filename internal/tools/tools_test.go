package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"

	"github.com/felinics/twilight/sdk"
	"golang.org/x/image/bmp"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/tools/codemode"
)

func TestNew(t *testing.T) {
	created, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	got := make([]string, len(created))
	for index, tool := range created {
		got[index] = tool.Name
	}
	want := []string{"read", "edit", "bash", "write"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("tool names = %v, want %v", got, want)
	}
}

func TestRead(t *testing.T) {
	set := newToolSet(t)
	lines := make([]string, maxOutputLines+1)
	for index := range lines {
		lines[index] = fmt.Sprintf("line-%d", index+1)
	}
	path := filepath.Join(set.cwd, "large.txt")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	output, err := set.read(t.Context(), readInput{Path: "large.txt"})
	if err != nil {
		t.Fatalf("read() error = %v", err)
	}
	if !strings.Contains(output, "line-2000") || strings.Contains(output, "line-2001\n") {
		t.Fatalf("read() returned unexpected lines")
	}
	if !strings.Contains(output, "Use offset=2001 to continue") {
		t.Fatalf("read() output lacks continuation notice: %q", output[len(output)-100:])
	}

	offset, limit := 2001, 1
	output, err = set.read(t.Context(), readInput{Path: path, Offset: &offset, Limit: &limit})
	if err != nil {
		t.Fatalf("read() continuation error = %v", err)
	}
	if output != "line-2001" {
		t.Fatalf("read() continuation = %q, want %q", output, "line-2001")
	}
}

func TestReadToolReturnsImageByContent(t *testing.T) {
	set := newToolSet(t)
	data := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDRimage-data")
	path := filepath.Join(set.cwd, "photo.txt")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write image: %v", err)
	}
	output, err := set.readTool().Execute(&toolkit.Context{Context: t.Context()}, map[string]any{"path": path})
	if err != nil {
		t.Fatalf("read tool error: %v", err)
	}
	image, ok := output.(sdk.ImagePart)
	if !ok || image.MediaType != "image/png" || image.Image != agent.FileURL(path) {
		t.Fatalf("read image = %#v", output)
	}
	resolved, err := agent.ResolveFileRefs([]sdk.Message{sdk.UserMessage("", image)})
	if err != nil {
		t.Fatalf("resolve image: %v", err)
	}
	got := resolved[0].Content[1].(sdk.ImagePart)
	if got.Image != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(data) {
		t.Fatalf("resolved image = %#v", got)
	}
}

func TestReadToolConvertsBMP(t *testing.T) {
	set := newToolSet(t)
	path := filepath.Join(set.cwd, "image.bmp")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	original := image.NewRGBA(image.Rect(0, 0, 1, 1))
	original.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := bmp.Encode(file, original); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := set.readTool().Execute(&toolkit.Context{Context: t.Context()}, map[string]any{"path": path})
	if err != nil {
		t.Fatalf("read BMP error: %v", err)
	}
	got, ok := output.(sdk.ImagePart)
	if !ok || got.MediaType != "image/png" {
		t.Fatalf("BMP image = %#v", output)
	}
	payload := strings.TrimPrefix(got.Image, "data:image/png;base64,")
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		t.Fatalf("decode PNG: %v", err)
	}
	converted, err := png.Decode(bytes.NewReader(decoded))
	if err != nil {
		t.Fatalf("decode converted PNG: %v", err)
	}
	if r, _, _, _ := converted.At(0, 0).RGBA(); r != 0xffff {
		t.Fatalf("converted pixel red = %d", r)
	}
}

func TestReadImageMediaType(t *testing.T) {
	for _, tt := range []struct {
		name, header, want string
	}{
		{"jpeg", "\xff\xd8\xff\xe0", "image/jpeg"},
		{"gif", "GIF89a", "image/gif"},
		{"webp", "RIFFxxxxWEBP", "image/webp"},
		{"text", "just text", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "file")
			if err := os.WriteFile(path, []byte(tt.header), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := readImageMediaType(path)
			if err != nil || got != tt.want {
				t.Fatalf("readImageMediaType() = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestReadPreservesTrailingNewlineAndHandlesLargeLimit(t *testing.T) {
	set := newToolSet(t)
	lines := make([]string, maxOutputLines)
	for index := range lines {
		lines[index] = "line"
	}
	content := strings.Join(lines, "\n") + "\n"
	path := filepath.Join(set.cwd, "lines.txt")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	output, err := set.read(t.Context(), readInput{Path: path})
	if err != nil {
		t.Fatalf("read() error = %v", err)
	}
	if output != content {
		t.Fatalf("read() did not preserve 2000-line file with trailing newline")
	}

	maxInt := int(^uint(0) >> 1)
	output, err = set.read(t.Context(), readInput{Path: path, Limit: &maxInt})
	if err != nil {
		t.Fatalf("read() with large limit error = %v", err)
	}
	if output != content {
		t.Fatalf("read() with large limit changed output")
	}
}

func TestReadMarksTrailingNewlineBeyondByteLimit(t *testing.T) {
	set := newToolSet(t)
	content := strings.Repeat("a", maxOutputBytes) + "\n"
	path := filepath.Join(set.cwd, "boundary.txt")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	output, err := set.read(t.Context(), readInput{Path: path})
	if err != nil {
		t.Fatalf("read() error = %v", err)
	}
	if !strings.Contains(output, "trailing newline omitted") {
		t.Fatalf("read() output lacks truncation notice")
	}
	body, _, _ := strings.Cut(output, "\n\n[Showing")
	if len(body) > maxOutputBytes {
		t.Fatalf("read() body is %d bytes, want at most %d", len(body), maxOutputBytes)
	}
}

func TestRemoveOldToolOutputKeepsRecentFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AMADEUS_HOME", home)
	directory := filepath.Join(home, ".tool-outputs")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatalf("create tool output directory: %v", err)
	}
	oldPath := filepath.Join(directory, "old.log")
	recentPath := filepath.Join(directory, "recent.log")
	if err := os.WriteFile(oldPath, []byte("old"), 0o600); err != nil {
		t.Fatalf("write old output: %v", err)
	}
	if err := os.WriteFile(recentPath, []byte("recent"), 0o600); err != nil {
		t.Fatalf("write recent output: %v", err)
	}
	now := time.Now()
	if err := os.Chtimes(oldPath, now, now.Add(-8*24*time.Hour)); err != nil {
		t.Fatalf("age old output: %v", err)
	}
	removed, err := removeOldToolOutput(now)
	if err != nil {
		t.Fatalf("removeOldToolOutput() error = %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old output stat error = %v", err)
	}
	if _, err := os.Stat(recentPath); err != nil {
		t.Fatalf("recent output stat error = %v", err)
	}
}

func TestWrite(t *testing.T) {
	set := newToolSet(t)
	input := writeInput{Path: "nested/file.txt ", Content: new("first")}
	if _, err := set.write(t.Context(), input); err != nil {
		t.Fatalf("write() error = %v", err)
	}
	input.Content = new("second")
	if _, err := set.write(t.Context(), input); err != nil {
		t.Fatalf("write() overwrite error = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(set.cwd, input.Path))
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(data) != "second" {
		t.Fatalf("written content = %q, want %q", data, "second")
	}
}

func TestRequiredToolStrings(t *testing.T) {
	created, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	writeTool := findTool(t, created, "write")
	path := filepath.Join(t.TempDir(), "existing.txt")
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	_, err = writeTool.Execute(&toolkit.Context{Context: t.Context()}, map[string]any{"path": path})
	if err == nil || !strings.Contains(err.Error(), "content is required") {
		t.Fatalf("write tool error = %v", err)
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read fixture: %v", readErr)
	}
	if string(data) != "keep" {
		t.Fatalf("write tool changed file to %q", data)
	}
	if _, err := writeTool.Execute(&toolkit.Context{Context: t.Context()}, map[string]any{
		"path":    path,
		"content": "",
	}); err != nil {
		t.Fatalf("write tool rejected explicit empty content: %v", err)
	}
	data, readErr = os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read empty file: %v", readErr)
	}
	if len(data) != 0 {
		t.Fatalf("write tool did not write explicit empty content")
	}
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatalf("restore fixture: %v", err)
	}

	editTool := findTool(t, created, "edit")
	_, err = editTool.Execute(&toolkit.Context{Context: t.Context()}, map[string]any{
		"path":  path,
		"edits": []map[string]any{{"oldText": "keep"}},
	})
	if err == nil || !strings.Contains(err.Error(), "newText is required") {
		t.Fatalf("edit tool error = %v", err)
	}
	data, readErr = os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read fixture: %v", readErr)
	}
	if string(data) != "keep" {
		t.Fatalf("edit tool changed file to %q", data)
	}
	if _, err := editTool.Execute(&toolkit.Context{Context: t.Context()}, map[string]any{
		"path":  path,
		"edits": []map[string]any{{"oldText": "keep", "newText": ""}},
	}); err != nil {
		t.Fatalf("edit tool rejected explicit empty newText: %v", err)
	}
	data, readErr = os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read empty edited file: %v", readErr)
	}
	if len(data) != 0 {
		t.Fatalf("edit tool did not apply explicit empty newText")
	}
}

func TestEditPreservesBOMAndCRLF(t *testing.T) {
	set := newToolSet(t)
	path := filepath.Join(set.cwd, "file.txt")
	original := append([]byte{0xEF, 0xBB, 0xBF}, []byte("one\r\ntwo\r\n")...)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	_, err := set.edit(t.Context(), editInput{
		Path: "file.txt",
		Edits: []replacement{
			{OldText: "one", NewText: new("ONE")},
			{OldText: "two", NewText: new("TWO")},
		},
	})
	if err != nil {
		t.Fatalf("edit() error = %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read edited file: %v", err)
	}
	want := append([]byte{0xEF, 0xBB, 0xBF}, []byte("ONE\r\nTWO\r\n")...)
	if !bytes.Equal(data, want) {
		t.Fatalf("edited bytes = %q, want %q", data, want)
	}
}

func TestEditRejectsInvalidReplacementsWithoutWriting(t *testing.T) {
	tests := []struct {
		name    string
		content string
		edits   []replacement
		wantErr string
	}{
		{
			name:    "missing",
			content: "alpha beta",
			edits:   []replacement{{OldText: "missing", NewText: new("value")}},
			wantErr: "not found",
		},
		{
			name:    "not unique",
			content: "alpha alpha",
			edits:   []replacement{{OldText: "alpha", NewText: new("value")}},
			wantErr: "2 occurrences",
		},
		{
			name:    "overlapping occurrences",
			content: "aaa",
			edits:   []replacement{{OldText: "aa", NewText: new("value")}},
			wantErr: "2 occurrences",
		},
		{
			name:    "overlap",
			content: "abcdef",
			edits: []replacement{
				{OldText: "abcd", NewText: new("value")},
				{OldText: "cdef", NewText: new("value")},
			},
			wantErr: "must not overlap",
		},
		{
			name:    "all edits use original",
			content: "alpha beta",
			edits: []replacement{
				{OldText: "alpha", NewText: new("gamma")},
				{OldText: "gamma", NewText: new("delta")},
			},
			wantErr: "not found",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			set := newToolSet(t)
			path := filepath.Join(set.cwd, "file.txt")
			if err := os.WriteFile(path, []byte(test.content), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}
			_, err := set.edit(t.Context(), editInput{Path: path, Edits: test.edits})
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("edit() error = %v, want containing %q", err, test.wantErr)
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatalf("read fixture: %v", readErr)
			}
			if string(data) != test.content {
				t.Fatalf("file changed to %q after failed edit", data)
			}
		})
	}
}

func TestBashToolReturnsStructuredResults(t *testing.T) {
	for _, test := range []struct {
		name    string
		command string
		output  string
		code    int
	}{
		{name: "success", command: "printf stdout; printf stderr >&2", output: "stdoutstderr"},
		{name: "nonzero", command: "printf problem; exit 7", output: "problem", code: 7},
		{name: "empty", command: "true"},
		{name: "signal", command: "kill -TERM $$", code: 143},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, err := newToolSet(t).bashTool().Execute(&toolkit.Context{Context: t.Context()}, map[string]any{"command": test.command})
			if err != nil {
				t.Fatalf("bash Execute() error = %v", err)
			}
			wire, err := toolkit.Output(value)
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Output          string  `json:"output"`
				Truncated       bool    `json:"truncated"`
				FullOutputPath  string  `json:"full_output_path"`
				ExitCode        int     `json:"exit_code"`
				WallTimeSeconds float64 `json:"wall_time_seconds"`
			}
			if err := json.Unmarshal([]byte(wire.String()), &result); err != nil {
				t.Fatalf("bash result is not structured JSON: %q: %v", wire.String(), err)
			}
			if result.Output != test.output || result.ExitCode != test.code || result.Truncated || result.FullOutputPath != "" || result.WallTimeSeconds <= 0 {
				t.Fatalf("bash result = %#v", result)
			}
		})
	}
}

func TestBash(t *testing.T) {
	set := newToolSet(t)
	output, err := set.bash(t.Context(), bashInput{Command: `printf stdout; printf stderr >&2`})
	if err != nil {
		t.Fatalf("bash() error = %v", err)
	}
	if !strings.Contains(output.Output, "stdout") || !strings.Contains(output.Output, "stderr") || output.ExitCode != 0 {
		t.Fatalf("bash() result = %#v", output)
	}

	output, err = set.bash(t.Context(), bashInput{Command: `printf problem; exit 7`})
	if err != nil || output.Output != "problem" || output.ExitCode != 7 {
		t.Fatalf("bash() nonzero result = %#v, %v", output, err)
	}
}

func TestBashCodemodeReturnsStructuredResults(t *testing.T) {
	result, err := codemode.Run(t.Context(), `
const results = await Promise.allSettled([
  tools.bash({command:"printf ok"}),
  tools.bash({command:"printf problem; exit 7"}),
  tools.bash({command:"true", timeout:-1}),
]);
return results.map(r => r.status === "fulfilled" ? [r.status, r.value.exit_code, r.value.output] : [r.status]);
`, []toolkit.Tool{newToolSet(t).bashTool()})
	if err != nil || result.IsError || !strings.Contains(result.Text, `[["fulfilled",0,"ok"],["fulfilled",7,"problem"],["rejected"]]`) {
		t.Fatalf("codemode bash result = %#v, %v", result, err)
	}
}

func TestBashStartFailureAndCancellationStillReject(t *testing.T) {
	set := newToolSet(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := set.bash(ctx, bashInput{Command: "true"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled bash error = %v", err)
	}
	set.shell = filepath.Join(t.TempDir(), "missing-bash")
	if _, err := set.bash(t.Context(), bashInput{Command: "true"}); err == nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("bash start error = %v", err)
	}
}

func TestBashCapturesLateOutput(t *testing.T) {
	set := newToolSet(t)
	output, err := set.bash(t.Context(), bashInput{Command: `printf done > >(sleep 0.05; cat)`})
	if err != nil {
		t.Fatalf("bash() error = %v", err)
	}
	if output.Output != "done" {
		t.Fatalf("bash() output = %q, want %q", output.Output, "done")
	}
}

func TestBashTimeout(t *testing.T) {
	set := newToolSet(t)
	timeout := 0.05
	_, err := set.bash(t.Context(), bashInput{Command: "sleep 10", Timeout: &timeout})
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("bash() error = %v, want timeout", err)
	}
}

func TestBashTruncatesOutput(t *testing.T) {
	set := newToolSet(t)
	output, err := set.bash(t.Context(), bashInput{Command: `for i in {1..2105}; do echo "line-$i"; done`})
	if err != nil {
		t.Fatalf("bash() error = %v", err)
	}
	path := fullOutputPath(t, output)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat full output: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Errorf("remove full output: %v", err)
		}
	})
	if !strings.Contains(output.Output, "line-2105") || strings.Contains(output.Output, "line-1\n") || output.ExitCode != 0 {
		t.Fatalf("bash() output lost tail or was not truncated: %#v", output)
	}
	full, err := os.ReadFile(path)
	if err != nil || !bytes.HasPrefix(full, []byte("line-1\n")) || !bytes.HasSuffix(full, []byte("line-2105\n")) {
		t.Fatalf("full bash output = %d bytes, %v", len(full), err)
	}
	if strings.Contains(output.Output, "[Output truncated.") {
		t.Fatal("output contains metadata instead of only command output")
	}
}

func TestBashTruncatesUTF8AtCharacterBoundary(t *testing.T) {
	set := newToolSet(t)
	output, err := set.bash(t.Context(), bashInput{Command: `for i in {1..12801}; do printf '𠀀'; done; printf x`})
	if err != nil {
		t.Fatalf("bash() error = %v", err)
	}
	path := fullOutputPath(t, output)
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Errorf("remove full output: %v", err)
		}
	})
	body := output.Output
	if !utf8.ValidString(body) {
		t.Fatalf("bash() returned invalid UTF-8")
	}
	if strings.Contains(body, "�") {
		t.Fatalf("bash() introduced a replacement character at the truncation boundary")
	}
	if len(body) > maxOutputBytes {
		t.Fatalf("bash() body is %d bytes, want at most %d", len(body), maxOutputBytes)
	}
}

func TestBashKeepsTailOfLongFinalLine(t *testing.T) {
	set := newToolSet(t)
	output, err := set.bash(t.Context(), bashInput{
		Command: `head -c 51201 /dev/zero | tr '\0' a; printf '\n'`,
	})
	if err != nil {
		t.Fatalf("bash() error = %v", err)
	}
	path := fullOutputPath(t, output)
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Errorf("remove full output: %v", err)
		}
	})
	body := output.Output
	if body == "" || !strings.Contains(body, "aaaa") {
		t.Fatalf("bash() discarded the long final line")
	}
}

func fullOutputPath(t *testing.T, result bashResult) string {
	t.Helper()
	if !result.Truncated || result.FullOutputPath == "" {
		t.Fatalf("truncated result lacks full output path: %#v", result)
	}
	return result.FullOutputPath
}

func findTool(t *testing.T, tools []toolkit.Tool, name string) toolkit.Tool {
	t.Helper()
	for _, tool := range tools {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %q not found", name)
	return toolkit.Tool{}
}

func TestToolsAllowPathsOutsideWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	created, err := New(root)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	writeTool := findTool(t, created, "write")
	_, err = writeTool.Execute(&toolkit.Context{Context: t.Context()}, map[string]any{
		"path":    "../outside.txt",
		"content": "shared",
	})
	if err != nil {
		t.Fatalf("write outside the directory: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(root), "outside.txt"))
	if err != nil || string(data) != "shared" {
		t.Fatalf("outside file = %q, %v", data, err)
	}
}

func newToolSet(t *testing.T) *toolSet {
	t.Helper()
	shell, err := exec.LookPath("bash")
	if err != nil {
		t.Fatalf("find bash: %v", err)
	}
	t.Setenv("AMADEUS_HOME", t.TempDir())
	return &toolSet{cwd: t.TempDir(), shell: shell}
}
