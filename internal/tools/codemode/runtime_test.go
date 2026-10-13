package codemode_test

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/tools/codemode"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	"github.com/felinics/twilight/sdk"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type echoInput struct {
	Text string `json:"text"`
}

func echoTool() toolkit.Tool {
	return toolkit.New("echo", "Echo text", func(_ *toolkit.Context, input echoInput) (any, error) { return input.Text, nil })
}

func run(t *testing.T, source string, tools ...toolkit.Tool) toolkit.Result {
	t.Helper()
	result, err := codemode.Run(t.Context(), source, tools)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestToolPromptUsesPiTextWithBehaviorDifferences(t *testing.T) {
	code, err := codemode.New([]toolkit.Tool{echoTool()})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"Run JavaScript that calls other tools.",
		"JSON object with a `code` string",
		"top-level `await` and `return` work",
		"Calls still running when the script ends are cancelled.",
		"`timeout_ms` is unset by default.",
		"Globals:",
		"find unlisted tools, such as MCP tools.",
		"full CallToolResult",
	} {
		if !strings.Contains(code.Description, want) {
			t.Fatalf("description missing %q: %s", want, code.Description)
		}
	}
	for _, absent := range []string{
		"raw JavaScript (not JSON",
		"<console_output>",
		"==> text",
		"store(key",
		"models",
		"declare const tools",
	} {
		if strings.Contains(code.Description, absent) {
			t.Fatalf("description advertises unsupported or duplicate behavior %q", absent)
		}
	}
}

func TestLocalToolDescriptionUsesPiCallHint(t *testing.T) {
	tool := echoTool()
	tool.Name = "lookup-page"
	want := "Echo text\n\nCodemode: `tools.lookup_page(args)`."
	if got := codemode.ScriptCallDescription(tool); got != want {
		t.Fatalf("description = %q, want %q", got, want)
	}
}

func TestParallelCallsAndToolValidation(t *testing.T) {
	result := run(t, `
const results = await Promise.allSettled([tools.echo({text:"one"}), tools.echo({text:"two"}), tools.echo({text:3})]);
return results.map(r => r.status === "fulfilled" ? r.value : r.reason.message);
`, echoTool())
	if result.IsError || !strings.Contains(result.Text, `"one","two","validate echo arguments`) {
		t.Fatalf("result = %#v", result)
	}
}

func TestScriptFailurePreservesOutputAndSideEffects(t *testing.T) {
	calls := 0
	tool := toolkit.New("change", "Change state", func(_ *toolkit.Context, _ struct{}) (any, error) {
		calls++
		return "changed", nil
	})
	result := run(t, `text(await tools.change({})); throw new Error("failed after change");`, tool)
	if !result.IsError || calls != 1 || !strings.Contains(result.Text, "changed") ||
		!strings.Contains(result.Text, "failed after change") || !strings.Contains(result.Text, "not undone") {
		t.Fatalf("result = %#v; calls = %d", result, calls)
	}
}

func TestCancelStopsVMAndNestedCalls(t *testing.T) {
	for _, source := range []string{`while (true) {}`, `await tools.wait({});`} {
		t.Run(source, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			timer := time.AfterFunc(50*time.Millisecond, cancel)
			defer timer.Stop()
			wait := toolkit.New("wait", "Wait for cancellation", func(call *toolkit.Context, _ struct{}) (any, error) {
				<-call.Done()
				return nil, call.Err()
			})
			if _, err := codemode.Run(ctx, source, []toolkit.Tool{wait}); !errors.Is(err, context.Canceled) {
				t.Fatalf("Run() error = %v", err)
			}
		})
	}
}

func TestExplicitTimeoutCancelsNestedCall(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	stopped := make(chan struct{})
	wait := toolkit.New("wait", "Wait", func(call *toolkit.Context, _ struct{}) (any, error) {
		<-call.Done()
		close(stopped)
		return nil, call.Err()
	})
	result, err := codemode.Run(ctx, "// @options: {\"timeout_ms\": 1000}\nawait tools.wait({});", []toolkit.Tool{wait})
	if err != nil || !result.IsError || ctx.Err() != nil {
		t.Fatalf("explicit timeout = %#v, %v; parent = %v", result, err, ctx.Err())
	}
	select {
	case <-stopped:
	default:
		t.Fatal("timed-out call was not stopped")
	}
}

func TestScriptEndCancelsUnawaitedCalls(t *testing.T) {
	cancelled := make(chan struct{})
	started := make(chan struct{})
	wait := toolkit.New("wait", "Wait", func(call *toolkit.Context, _ struct{}) (any, error) {
		close(started)
		<-call.Done()
		close(cancelled)
		return nil, call.Err()
	})
	// The awaited release makes sure the first call has started before the script returns.
	release := toolkit.New("release", "Release", func(call *toolkit.Context, _ struct{}) (any, error) {
		select {
		case <-started:
			return nil, nil
		case <-call.Done():
			return nil, call.Err()
		}
	})
	result := run(t, `tools.wait({}); await tools.release({}); return "done";`, wait, release)
	if result.IsError {
		t.Fatalf("result = %#v", result)
	}
	select {
	case <-cancelled:
	default:
		t.Fatal("unawaited call was not cancelled and joined")
	}
}

func TestToolContextIsInherited(t *testing.T) {
	type key struct{}
	ctx := context.WithValue(t.Context(), key{}, "chat-scope")
	tool := toolkit.New("scope", "Read scope", func(call *toolkit.Context, _ struct{}) (any, error) {
		return map[string]any{"scope": call.Value(key{}), "name": call.ToolName, "id": call.ToolCallID}, nil
	})
	code, err := codemode.New([]toolkit.Tool{tool})
	if err != nil {
		t.Fatal(err)
	}
	value, err := code.Execute(&toolkit.Context{Context: ctx, ToolCallID: "outer"}, map[string]any{"code": `return await tools.scope({});`})
	if err != nil {
		t.Fatal(err)
	}
	result := value.(toolkit.Result)
	if result.IsError || !strings.Contains(result.Text, `"scope":"chat-scope"`) || !strings.Contains(result.Text, `"id":"outer/1"`) {
		t.Fatalf("result = %#v", result)
	}
}

func TestMCPDiscoveryAndRawResults(t *testing.T) {
	remote := echoTool()
	remote.Name, remote.Namespace, remote.Description = "docs__lookup-page", "docs", "Look up documentation pages"
	remote.Execute = func(*toolkit.Context, any) (any, error) {
		return &mcpsdk.CallToolResult{
			Content:           []mcpsdk.Content{&mcpsdk.TextContent{Text: strings.Repeat("full", 20000)}},
			StructuredContent: map[string]any{"answer": 42}, IsError: true,
		}, nil
	}
	code, err := codemode.New([]toolkit.Tool{echoTool(), remote})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(code.Description, "docs__lookup") {
		t.Fatal("MCP declaration was inlined")
	}
	result := run(t, `
const found = await searchTools("documentation", {namespace:"docs"});
const tool = await describeTool(found[0].name);
const namespace = await describeNamespace("docs");
const raw = await tools.docs__lookup_page({text:"query"});
return {name:found[0].name, declaration:tool.declaration.includes("text: string"), count:namespace.tools.length,
  length:raw.content[0].text.length, structured:raw.structuredContent.answer, isError:raw.isError,
  unknown:(await describeTool("not-allowed")) === undefined};
`, echoTool(), remote)
	for _, want := range []string{`"name":"docs__lookup_page"`, `"declaration":true`, `"count":1`, `"length":80000`, `"structured":42`, `"isError":true`, `"unknown":true`} {
		if result.IsError || !strings.Contains(result.Text, want) {
			t.Fatalf("result = %#v, want %s", result, want)
		}
	}
}

func TestValidateDoesNotRunSource(t *testing.T) {
	for _, source := range []string{`while (true) {}`, `await tools.agent({prompt:"look"}); return 1;`, `for await (const item of []) {}`, `throw new Error("not executed");`} {
		if err := codemode.Validate(t.Context(), source); err != nil {
			t.Fatalf("Validate(%q) = %v", source, err)
		}
	}
	for _, source := range []string{"", `const = 1;`, `}; throw new Error("escaped"); {`, `import x from "fs";`} {
		if err := codemode.Validate(t.Context(), source); err == nil {
			t.Fatalf("Validate(%q) accepted invalid function body", source)
		}
	}
}

func TestNoAmbientCapabilitiesOrRecursiveCodemode(t *testing.T) {
	result := run(t, `return [typeof fetch, typeof process, typeof require, typeof setTimeout, typeof agent];`)
	if result.IsError || !strings.Contains(result.Text, `["undefined","undefined","undefined","undefined","undefined"]`) {
		t.Fatalf("result = %#v", result)
	}
	if recursive := run(t, `await tools.codemode({code:"return 1"});`); !recursive.IsError {
		t.Fatal("recursive codemode was callable")
	}
	if _, err := codemode.New([]toolkit.Tool{{Name: "codemode"}}); err == nil {
		t.Fatal("recursive codemode was allowed")
	}
	if _, err := codemode.New([]toolkit.Tool{{Name: "foo-bar"}, {Name: "foo_bar"}}); err == nil {
		t.Fatal("identifier collision was allowed")
	}
}

func TestImageOutputCanBePersisted(t *testing.T) {
	t.Setenv("AMADEUS_HOME", t.TempDir())
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "image.png")
	if err := os.WriteFile(path, encoded.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	read := toolkit.New("read", "Read image", func(*toolkit.Context, struct{}) (any, error) {
		return sdk.ImagePart{Image: (&url.URL{Scheme: "file", Path: path}).String(), MediaType: "image/png"}, nil
	})
	result := run(t, `image(await tools.read({})); text("shown");`, read)
	if result.IsError || len(result.Images) != 1 || !strings.Contains(result.Text, "shown") || !strings.Contains(result.Text, "Image saved to:") {
		t.Fatalf("result = %#v", result)
	}
	location, err := url.Parse(result.Images[0].Image)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(location.Path)
	if err != nil || !bytes.Equal(data, encoded.Bytes()) {
		t.Fatalf("saved image error = %v; bytes = %d", err, len(data))
	}
	info, err := os.Stat(location.Path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("image permissions: %v, %v", info, err)
	}
}

func TestOutputTruncatesOnlyAtModelBoundary(t *testing.T) {
	t.Setenv("AMADEUS_HOME", t.TempDir())
	large := toolkit.New("large", "Large result", func(*toolkit.Context, struct{}) (any, error) { return strings.Repeat("x", 90000), nil })
	filtered := run(t, `return (await tools.large({})).length;`, large)
	if filtered.IsError || !strings.Contains(filtered.Text, "90000") || strings.Contains(filtered.Text, "truncated") {
		t.Fatalf("filtered = %#v", filtered)
	}
	full := run(t, "// @options: {\"max_output_tokens\": 100}\nreturn await tools.large({});", large)
	_, path, found := strings.Cut(full.Text, "Full output: ")
	if full.IsError || !found || !strings.Contains(full.Text, "output truncated") {
		t.Fatalf("full = %#v", full)
	}
	content, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(content), strings.Repeat("x", 90000)) {
		t.Fatalf("full output file: %v", err)
	}
}
