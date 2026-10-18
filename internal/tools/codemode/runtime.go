package codemode

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	quickjs "github.com/MichaelKinsy/PiG/codemode"
	"github.com/felinics/twilight/sdk"
)

const PromptSnippet = "Run JavaScript that calls other tools"

const PromptGuideline = "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."

const description = "Run JavaScript that calls other tools. The input is a JSON object with a `code` string containing JavaScript (no code fence), run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.\n" +
	"- `await tools.<name>({ ...args })` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. MCP tools resolve to their full CallToolResult, including `content`, `structuredContent`, and `isError`; check its fields. Calls still running when the script ends are cancelled.\n" +
	"- Optional first line: `// @options: {\"max_output_tokens\": 10000, \"timeout_ms\": 60000}`. `timeout_ms` is unset by default.\n\n" +
	"Globals:\n" +
	"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. Text and image items appear in order. `image()` also saves the image to a file, and the result names its path.\n" +
	"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.\n" +
	"- `bash` resolves to `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, including for non-zero exit codes. `read` resolves to file text or an image block `{ type: \"image\", data, mimeType }` that `image()` shows. Other local tools resolve to their text output. Scripts cannot call codemode itself. Calls made before a failure are not undone."

const memoryLimit = 256 << 20

type input struct {
	Code string `json:"code" jsonschema:"Raw JavaScript source."`
}

func New(tools []toolkit.Tool) (toolkit.Tool, error) {
	tools = slices.Clone(tools)
	catalog, err := newCatalog(tools)
	if err != nil {
		return toolkit.Tool{}, err
	}
	return toolkit.New("codemode", description, func(ctx *toolkit.Context, input input) (any, error) {
		return execute(ctx, input.Code, tools, catalog)
	}), nil
}

func Run(ctx context.Context, source string, tools []toolkit.Tool) (toolkit.Result, error) {
	catalog, err := newCatalog(tools)
	if err != nil {
		return toolkit.Result{}, err
	}
	return execute(&toolkit.Context{Context: ctx, ToolCallID: "script", ToolName: "codemode"}, source, tools, catalog)
}

func Validate(ctx context.Context, source string) error {
	parsed, err := quickjs.ParseCodemodeSource(source)
	if err != nil {
		return fmt.Errorf("script: %w", err)
	}
	encoded, err := json.Marshal(parsed.Code)
	if err != nil {
		return fmt.Errorf("encode script: %w", err)
	}
	sandbox, err := quickjs.NewSandbox(quickjs.SandboxOptions{TimeoutMs: math.Inf(1), MemoryLimitBytes: memoryLimit})
	if err != nil {
		return fmt.Errorf("create script validator: %w", err)
	}
	defer func() { _ = sandbox.Close() }()
	code := `const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor; new AsyncFunction("tools", "console", ` + string(encoded) + `);`
	result, err := sandbox.Execute(ctx, code, quickjs.ExecuteOptions{})
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return fmt.Errorf("compile script: %w", err)
	}
	if !result.OK {
		return fmt.Errorf("script: %s", scriptError(result.Error))
	}
	return nil
}

func execute(ctx *toolkit.Context, source string, tools []toolkit.Tool, catalog *catalog) (toolkit.Result, error) {
	parsed, err := quickjs.ParseCodemodeSource(source)
	if err != nil {
		return toolkit.Result{}, err
	}
	timeout := math.Inf(1)
	if parsed.Options.TimeoutMs != nil {
		timeout = float64(*parsed.Options.TimeoutMs)
	}
	var sequence atomic.Uint64
	bindings := make([]quickjs.Tool, len(tools))
	for index, tool := range tools {
		bindings[index] = catalog.entries[index].binding
		bindings[index].Execute = func(callCtx context.Context, raw json.RawMessage) (json.RawMessage, error) {
			call := &toolkit.Context{
				Context: callCtx, ToolCallID: fmt.Sprintf("%s/%d", ctx.ToolCallID, sequence.Add(1)),
				ToolName: tool.Name, Nested: true, SendProgress: ctx.SendProgress,
			}
			value, err := toolkit.Execute(call, tool, sdk.ParseToolArguments(string(raw)))
			if err != nil {
				return nil, err
			}
			return scriptValue(value)
		}
	}
	sandbox, err := quickjs.NewSandbox(quickjs.SandboxOptions{
		Tools: bindings, Globals: catalog.globals(), TimeoutMs: timeout, MemoryLimitBytes: memoryLimit,
	})
	if err != nil {
		return toolkit.Result{}, fmt.Errorf("create QuickJS sandbox: %w", err)
	}
	defer func() { _ = sandbox.Close() }()
	started := time.Now()
	result, err := sandbox.Execute(ctx, parsed.Code, quickjs.ExecuteOptions{})
	if ctx.Err() != nil {
		return toolkit.Result{}, ctx.Err()
	}
	if err != nil {
		return toolkit.Result{}, fmt.Errorf("run script: %w", err)
	}
	return formatResult(result, time.Since(started), parsed.Options.MaxOutputTokens)
}

func scriptError(err *quickjs.Error) string {
	if err == nil {
		return "unknown script error"
	}
	if err.Stack != "" {
		return err.Stack
	}
	if err.Name != "" {
		return err.Name + ": " + err.Message
	}
	return strings.TrimSpace(err.Message)
}
