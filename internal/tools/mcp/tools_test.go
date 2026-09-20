package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/felinics/twilight/sdk"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPLogsSerializableRawConnections(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	t.Setenv("MCP_TOKEN", "raw-secret")

	set, err := load(t.Context(), t.TempDir(), []Server{
		{Name: "remote", Transport: "http", URL: "https://mcp.example.com", Headers: map[string]string{"Authorization": "Bearer ${MCP_TOKEN}"}},
		{Name: "local", Transport: "stdio", Command: "mcp-server", Args: []string{"--stdio"}},
	}, nil, func(context.Context, *sdk.MCPClientConfig) (client, error) {
		return &fakeClient{}, nil
	})
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})

	for line := range strings.Lines(logs.String()) {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log: %v\nline: %s", err, line)
		}
	}
	for _, want := range []string{"https://mcp.example.com", "raw-secret", "mcp-server", "--stdio"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("logs = %q, want containing %q", logs.String(), want)
		}
	}
	if strings.Contains(logs.String(), "!ERROR") {
		t.Fatalf("logs contain serialization error: %s", logs.String())
	}
}

func TestStdioStderrUsesStructuredLogger(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	transport := newTestCommandTransport(t, "printf 'raw child error\\n' >&2; exec cat >/dev/null")
	connection, err := transport.Connect(t.Context())
	if err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	if err := connection.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	var record map[string]any
	if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
		t.Fatalf("decode log: %v\noutput: %s", err, logs.String())
	}
	if record["level"] != "WARN" || record["mcp_server"] != "local" ||
		record["stream"] != "stderr" || record["content"] != "raw child error\n" {
		t.Fatalf("record = %#v", record)
	}
}

func TestStdioStderrIsConsumedWhenWarningsAreDisabled(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelError})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	transport := newTestCommandTransport(t, "i=0; while [ $i -lt 1000 ]; do echo raw-error >&2; i=$((i+1)); done; exec cat >/dev/null")
	connection, err := transport.Connect(t.Context())
	if err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	if err := connection.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if logs.Len() != 0 {
		t.Fatalf("logs = %q, want empty", logs.String())
	}
}

func TestStdioCloseDoesNotWaitForDescendantStderr(t *testing.T) {
	pidFile := t.TempDir() + "/pid"
	transport := newTestCommandTransport(t, fmt.Sprintf("sleep 5 >&2 & echo $! > %q; exec cat >/dev/null", pidFile))
	connection, err := transport.Connect(t.Context())
	if err != nil {
		t.Fatalf("Connect() error = %v", err)
	}

	transport.Command.WaitDelay = 50 * time.Millisecond
	started := time.Now()
	if err := connection.Close(); !errors.Is(err, exec.ErrWaitDelay) {
		t.Fatalf("Close() error = %v, want ErrWaitDelay", err)
	}
	elapsed := time.Since(started)
	pidData, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read descendant PID: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if err != nil {
		t.Fatalf("parse descendant PID: %v", err)
	}
	t.Cleanup(func() {
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			t.Errorf("kill descendant: %v", err)
		}
	})
	if elapsed > time.Second {
		t.Fatalf("Close() took %s", elapsed)
	}
}

func TestStdioCloseStopsContinuouslyWritingDescendant(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelError})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	transport := newTestCommandTransport(t, "(while :; do printf x >&2; done) & exec cat >/dev/null")
	connection, err := transport.Connect(t.Context())
	if err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	transport.Command.WaitDelay = 50 * time.Millisecond
	started := time.Now()
	if err := connection.Close(); !errors.Is(err, exec.ErrWaitDelay) {
		t.Fatalf("Close() error = %v, want ErrWaitDelay", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Close() took %s", elapsed)
	}
}

func TestLoadConfiguresHTTPAndStdioServers(t *testing.T) {
	t.Setenv("MCP_TOKEN", "secret")
	t.Setenv("MCP_MODE", "safe")
	servers := []Server{
		{
			Name:      "remote",
			Transport: "http",
			URL:       "https://mcp.example.com",
			Headers: map[string]string{
				"X-Client":      "amadeus",
				"Authorization": "Bearer ${MCP_TOKEN}",
			},
		},
		{
			Name:      "local",
			Transport: "stdio",
			Command:   "mcp-server",
			Args:      []string{"--stdio"},
			Env:       map[string]string{"MODE": "${MCP_MODE}"},
		},
	}
	localTools := []sdk.Tool{{Name: "read"}}
	var configs []*sdk.MCPClientConfig
	clients := []*fakeClient{
		{tools: []sdk.Tool{{Name: "remote_search"}}},
		{tools: []sdk.Tool{{Name: "local_lookup"}}},
	}
	factory := func(_ context.Context, config *sdk.MCPClientConfig) (client, error) {
		configs = append(configs, config)
		return clients[len(configs)-1], nil
	}

	workspace := t.TempDir()
	set, err := load(t.Context(), workspace, servers, localTools, factory)
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	if got := toolNames(set.Tools()); !reflect.DeepEqual(got, []string{"read", "remote_search", "local_lookup"}) {
		t.Fatalf("tool names = %v", got)
	}
	httpTransport, ok := configs[0].Transport.(*mcpsdk.StreamableClientTransport)
	if !ok {
		t.Fatalf("HTTP transport = %T", configs[0].Transport)
	}
	if httpTransport.Endpoint != "https://mcp.example.com" || !httpTransport.DisableStandaloneSSE {
		t.Fatalf("HTTP transport = %#v", httpTransport)
	}
	safeTransport, ok := httpTransport.HTTPClient.Transport.(mcpHTTPTransport)
	if !ok {
		t.Fatalf("HTTP RoundTripper = %T", httpTransport.HTTPClient.Transport)
	}
	if safeTransport.headers["Authorization"] != "Bearer secret" || safeTransport.headers["X-Client"] != "amadeus" {
		t.Fatalf("HTTP headers = %#v", safeTransport.headers)
	}
	transport, ok := configs[1].Transport.(*mcpsdk.CommandTransport)
	if !ok {
		t.Fatalf("stdio transport = %T", configs[1].Transport)
	}
	command := transport.Command
	if command.Path != "mcp-server" || !reflect.DeepEqual(command.Args, []string{"mcp-server", "--stdio"}) {
		t.Fatalf("stdio command = %#v", command.Args)
	}
	if command.Dir != workspace {
		t.Fatalf("stdio working directory = %q, want %q", command.Dir, workspace)
	}
	if !contains(command.Env, "MODE=safe") {
		t.Fatalf("stdio environment lacks MODE=safe")
	}
}

func TestLoadUsesTwilightMCPTools(t *testing.T) {
	server := mcpsdk.NewServer(&mcpsdk.Implementation{Name: "test", Version: "v1"}, nil)
	type echoInput struct {
		Text string `json:"text"`
	}
	mcpsdk.AddTool(server, &mcpsdk.Tool{Name: "echo", Description: "Echo text"},
		func(_ context.Context, _ *mcpsdk.CallToolRequest, input echoInput) (*mcpsdk.CallToolResult, any, error) {
			return &mcpsdk.CallToolResult{Content: []mcpsdk.Content{
				&mcpsdk.TextContent{Text: "echo: " + input.Text},
			}}, nil, nil
		})
	serverTransport, clientTransport := mcpsdk.NewInMemoryTransports()
	go func() {
		_ = server.Run(t.Context(), serverTransport)
	}()

	set, err := load(t.Context(), t.TempDir(), []Server{
		{Name: "test", Transport: "http", URL: "https://unused.example.com"},
	}, nil, func(ctx context.Context, _ *sdk.MCPClientConfig) (client, error) {
		return sdk.CreateMCPClient(ctx, &sdk.MCPClientConfig{Transport: clientTransport})
	})
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	tools := set.Tools()
	if len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("tools = %#v", tools)
	}
	result, err := tools[0].Execute(&sdk.ToolExecContext{Context: t.Context()}, map[string]any{"text": "hello"})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if result != "echo: hello" {
		t.Fatalf("Execute() result = %#v", result)
	}
}

func TestLoadRejectsInvalidServerConfig(t *testing.T) {
	unsetEnvironment(t, "MISSING_MCP_TEST_TOKEN")
	tests := []struct {
		name    string
		servers []Server
		wantErr string
	}{
		{
			name:    "missing name",
			servers: []Server{{Transport: "http", URL: "https://example.com"}},
			wantErr: "server name is required",
		},
		{
			name: "duplicate name",
			servers: []Server{
				{Name: "same", Transport: "http", URL: "https://one.example.com"},
				{Name: "same", Transport: "http", URL: "https://two.example.com"},
			},
			wantErr: `duplicate MCP server name "same"`,
		},
		{
			name:    "missing HTTP URL",
			servers: []Server{{Name: "remote", Transport: "http"}},
			wantErr: "url is required",
		},
		{
			name:    "missing stdio command",
			servers: []Server{{Name: "local", Transport: "stdio"}},
			wantErr: "command is required",
		},
		{
			name:    "unsupported SSE",
			servers: []Server{{Name: "legacy", Transport: "sse", URL: "https://example.com"}},
			wantErr: `unsupported transport "sse"`,
		},
		{
			name: "mixed HTTP and stdio",
			servers: []Server{{
				Name: "mixed", Transport: "http", URL: "https://example.com", Command: "server",
			}},
			wantErr: "only valid for stdio",
		},
		{
			name: "invalid environment name",
			servers: []Server{{
				Name: "local", Transport: "stdio", Command: "server", Env: map[string]string{"BAD-NAME": "value"},
			}},
			wantErr: "invalid environment variable name",
		},
		{
			name: "duplicate HTTP header",
			servers: []Server{{
				Name: "remote", Transport: "http", URL: "https://example.com",
				Headers: map[string]string{"Authorization": "one", "authorization": "two"},
			}},
			wantErr: "duplicate HTTP header name",
		},
		{
			name: "missing environment reference",
			servers: []Server{{
				Name: "remote", Transport: "http", URL: "https://example.com",
				Headers: map[string]string{"Authorization": "Bearer ${MISSING_MCP_TEST_TOKEN}"},
			}},
			wantErr: "environment variable MISSING_MCP_TEST_TOKEN is not set",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := load(t.Context(), t.TempDir(), test.servers, nil, func(context.Context, *sdk.MCPClientConfig) (client, error) {
				return &fakeClient{}, nil
			})
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("load() error = %v, want containing %q", err, test.wantErr)
			}
		})
	}
}

func TestHTTPClientRejectsRedirects(t *testing.T) {
	targetCalled := false
	sourceAuthorization := ""
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		targetCalled = true
	}))
	t.Cleanup(target.Close)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		sourceAuthorization = request.Header.Get("Authorization")
		http.Redirect(w, request, target.URL, http.StatusFound)
	}))
	t.Cleanup(source.Close)

	config, err := clientConfig(Server{
		Name: "remote", Transport: "http", URL: source.URL,
		Headers: map[string]string{"Authorization": "Bearer secret"},
	}, t.TempDir())
	if err != nil {
		t.Fatalf("clientConfig() error = %v", err)
	}
	transport, ok := config.Transport.(*mcpsdk.StreamableClientTransport)
	if !ok {
		t.Fatalf("HTTP transport = %T", config.Transport)
	}
	response, err := transport.HTTPClient.Get(source.URL)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatalf("close response body: %v", err)
	}
	if response.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusFound)
	}
	if sourceAuthorization != "Bearer secret" {
		t.Fatalf("Authorization = %q", sourceAuthorization)
	}
	if targetCalled {
		t.Fatal("HTTP client followed redirect")
	}
}

func TestHTTPTransportRejectsFailedSessionDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "failed", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	request, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, server.URL, nil)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}

	_, err = (mcpHTTPTransport{base: http.DefaultTransport}).RoundTrip(request)
	if err == nil || !strings.Contains(err.Error(), "HTTP status 500") {
		t.Fatalf("RoundTrip() error = %v", err)
	}
}

func TestLoadClosesClientsOnFailure(t *testing.T) {
	var closeOrder []string
	first := &fakeClient{name: "first", closeOrder: &closeOrder, tools: []sdk.Tool{{Name: "one"}}}
	second := &fakeClient{name: "second", closeOrder: &closeOrder, toolsErr: errors.New("list failed")}
	clients := []*fakeClient{first, second}
	created := 0

	_, err := load(t.Context(), t.TempDir(), []Server{
		{Name: "first", Transport: "http", URL: "https://one.example.com"},
		{Name: "second", Transport: "http", URL: "https://two.example.com"},
	}, nil, func(context.Context, *sdk.MCPClientConfig) (client, error) {
		client := clients[created]
		created++
		return client, nil
	})
	if err == nil || !strings.Contains(err.Error(), "list failed") {
		t.Fatalf("load() error = %v", err)
	}
	if !reflect.DeepEqual(closeOrder, []string{"second", "first"}) {
		t.Fatalf("close order = %v", closeOrder)
	}
}

func TestLoadRejectsDuplicateToolAndClosesClient(t *testing.T) {
	remote := &fakeClient{tools: []sdk.Tool{{Name: "read"}}}
	_, err := load(t.Context(), t.TempDir(), []Server{
		{Name: "remote", Transport: "http", URL: "https://example.com"},
	}, []sdk.Tool{{Name: "read"}}, func(context.Context, *sdk.MCPClientConfig) (client, error) {
		return remote, nil
	})
	if err == nil || !strings.Contains(err.Error(), `duplicate tool name "read"`) {
		t.Fatalf("load() error = %v", err)
	}
	if remote.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", remote.closeCalls)
	}
}

func TestSetCloseIsReverseOrderAndIdempotent(t *testing.T) {
	var closeOrder []string
	set := &Set{clients: []client{
		&fakeClient{name: "first", closeOrder: &closeOrder},
		&fakeClient{name: "second", closeOrder: &closeOrder},
	}}
	if err := set.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := set.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
	if !reflect.DeepEqual(closeOrder, []string{"second", "first"}) {
		t.Fatalf("close order = %v", closeOrder)
	}
}

func TestToolsReturnsCopy(t *testing.T) {
	set := &Set{tools: []sdk.Tool{{Name: "one"}}}
	tools := set.Tools()
	tools[0].Name = "changed"
	if set.Tools()[0].Name != "one" {
		t.Fatal("Tools() exposed internal slice")
	}
}

type fakeClient struct {
	name       string
	tools      []sdk.Tool
	toolsErr   error
	closeErr   error
	closeOrder *[]string
	closeCalls int
}

func (c *fakeClient) Tools(context.Context) ([]sdk.Tool, error) {
	return c.tools, c.toolsErr
}

func (c *fakeClient) Close() error {
	c.closeCalls++
	if c.closeOrder != nil {
		*c.closeOrder = append(*c.closeOrder, c.name)
	}
	return c.closeErr
}

func toolNames(tools []sdk.Tool) []string {
	names := make([]string, len(tools))
	for index, tool := range tools {
		names[index] = tool.Name
	}
	return names
}

func unsetEnvironment(t *testing.T, name string) {
	t.Helper()
	value, exists := os.LookupEnv(name)
	if err := os.Unsetenv(name); err != nil {
		t.Fatalf("unset %s: %v", name, err)
	}
	t.Cleanup(func() {
		if exists {
			if err := os.Setenv(name, value); err != nil {
				t.Errorf("restore %s: %v", name, err)
			}
		}
	})
}

func newTestCommandTransport(t *testing.T, script string) *mcpsdk.CommandTransport {
	t.Helper()
	config, err := clientConfig(Server{
		Name: "local", Transport: "stdio", Command: "sh", Args: []string{"-c", script},
	}, t.TempDir())
	if err != nil {
		t.Fatalf("clientConfig() error = %v", err)
	}
	transport, ok := config.Transport.(*mcpsdk.CommandTransport)
	if !ok {
		t.Fatalf("transport = %T", config.Transport)
	}
	return transport
}

func contains(values []string, want string) bool {
	return slices.Contains(values, want)
}
