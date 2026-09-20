package mcp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/felinics/twilight/sdk"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

var (
	environmentReferencePattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)
	environmentNamePattern      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

type Server struct {
	Name      string
	Transport string
	URL       string
	Headers   map[string]string
	Command   string
	Args      []string
	Env       map[string]string
}

type connectionLog struct {
	Transport        string            `json:"transport"`
	Endpoint         string            `json:"endpoint,omitempty"`
	Headers          map[string]string `json:"headers,omitempty"`
	Command          string            `json:"command,omitempty"`
	Args             []string          `json:"args,omitempty"`
	WorkingDirectory string            `json:"workingDirectory,omitempty"`
	Environment      []string          `json:"environment,omitempty"`
}

type logWriter struct {
	logger *slog.Logger
}

func (w logWriter) Write(data []byte) (int, error) {
	w.logger.Warn("MCP stderr", "content", string(data))
	return len(data), nil
}

type Set struct {
	tools     []sdk.Tool
	clients   []client
	closeOnce sync.Once
	closeErr  error
}

type client interface {
	Tools(ctx context.Context) ([]sdk.Tool, error)
	Close() error
}

type clientFactory func(ctx context.Context, config *sdk.MCPClientConfig) (client, error)

func Load(ctx context.Context, workingDirectory string, servers []Server, localTools []sdk.Tool) (*Set, error) {
	return load(ctx, workingDirectory, servers, localTools, createClient)
}

func createClient(ctx context.Context, config *sdk.MCPClientConfig) (client, error) {
	return sdk.CreateMCPClient(ctx, config)
}

func load(
	ctx context.Context,
	workingDirectory string,
	servers []Server,
	localTools []sdk.Tool,
	create clientFactory,
) (*Set, error) {
	slog.DebugContext(ctx, "Loading tools", "working_directory", workingDirectory, "servers", servers, "local_tools", localTools)
	if strings.TrimSpace(workingDirectory) == "" {
		return nil, errors.New("working directory is required")
	}
	workingDirectory, err := filepath.Abs(workingDirectory)
	if err != nil {
		return nil, fmt.Errorf("resolve working directory: %w", err)
	}
	set := &Set{tools: slices.Clone(localTools)}
	toolNames := make(map[string]string, len(localTools))
	for _, tool := range localTools {
		if tool.Name == "" {
			return nil, errors.New("local tool name is required")
		}
		if previous, exists := toolNames[tool.Name]; exists {
			return nil, fmt.Errorf("duplicate tool name %q from %s and local tools", tool.Name, previous)
		}
		toolNames[tool.Name] = "local tools"
	}

	serverNames := make(map[string]struct{}, len(servers))
	for _, server := range servers {
		name := strings.TrimSpace(server.Name)
		if name == "" {
			return nil, closeOnError(set, errors.New("MCP server name is required"))
		}
		if _, exists := serverNames[name]; exists {
			return nil, closeOnError(set, fmt.Errorf("duplicate MCP server name %q", name))
		}
		serverNames[name] = struct{}{}

		config, err := clientConfig(server, workingDirectory)
		if err != nil {
			return nil, closeOnError(set, fmt.Errorf("configure MCP server %q: %w", name, err))
		}
		slog.DebugContext(ctx, "Connecting MCP server", "server", server, "connection", connectionLogValue(config))
		mcpClient, err := create(ctx, config)
		if err != nil {
			return nil, closeOnError(set, fmt.Errorf("connect MCP server %q: %w", name, err))
		}
		set.clients = append(set.clients, mcpClient)

		remoteTools, err := mcpClient.Tools(ctx)
		if err != nil {
			return nil, closeOnError(set, fmt.Errorf("list tools from MCP server %q: %w", name, err))
		}
		slog.DebugContext(ctx, "Loaded MCP server tools", "server", server, "tools", remoteTools)
		for _, tool := range remoteTools {
			if tool.Name == "" {
				return nil, closeOnError(set, fmt.Errorf("MCP server %q returned a tool without a name", name))
			}
			if previous, exists := toolNames[tool.Name]; exists {
				return nil, closeOnError(set, fmt.Errorf(
					"duplicate tool name %q from MCP server %q and %s",
					tool.Name,
					name,
					previous,
				))
			}
			toolNames[tool.Name] = fmt.Sprintf("MCP server %q", name)
			set.tools = append(set.tools, tool)
		}
	}
	slog.InfoContext(ctx, "Loaded tools", "local_tools", len(localTools), "mcp_servers", len(servers), "tools", len(set.tools))
	return set, nil
}

func clientConfig(server Server, workingDirectory string) (*sdk.MCPClientConfig, error) {
	transport := strings.ToLower(strings.TrimSpace(server.Transport))
	switch transport {
	case "", "http":
		if strings.TrimSpace(server.URL) == "" {
			return nil, errors.New("url is required for HTTP transport")
		}
		if strings.TrimSpace(server.Command) != "" || len(server.Args) > 0 || len(server.Env) > 0 {
			return nil, errors.New("command, args, and env are only valid for stdio transport")
		}
		headers, err := expandHeaders(server.Headers)
		if err != nil {
			return nil, fmt.Errorf("expand headers: %w", err)
		}
		httpClient := &http.Client{
			Transport: mcpHTTPTransport{base: http.DefaultTransport, headers: headers},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		return &sdk.MCPClientConfig{
			Transport: &mcpsdk.StreamableClientTransport{
				Endpoint:             strings.TrimSpace(server.URL),
				HTTPClient:           httpClient,
				DisableStandaloneSSE: true,
			},
			Name: "amadeus",
		}, nil

	case "stdio":
		if strings.TrimSpace(server.Command) == "" {
			return nil, errors.New("command is required for stdio transport")
		}
		if strings.TrimSpace(server.URL) != "" || len(server.Headers) > 0 {
			return nil, errors.New("url and headers are only valid for HTTP transport")
		}
		environment, err := expandMap(server.Env, true)
		if err != nil {
			return nil, fmt.Errorf("expand env: %w", err)
		}
		command := exec.Command(strings.TrimSpace(server.Command), server.Args...)
		command.Dir = workingDirectory
		command.Env = append(os.Environ(), sortedEnvironment(environment)...)
		command.WaitDelay = 5 * time.Second
		stderrLogger := slog.Default().With("mcp_server", strings.TrimSpace(server.Name), "stream", "stderr")
		command.Stderr = logWriter{logger: stderrLogger}
		return &sdk.MCPClientConfig{
			Transport: &mcpsdk.CommandTransport{Command: command},
			Name:      "amadeus",
		}, nil

	default:
		return nil, fmt.Errorf("unsupported transport %q", server.Transport)
	}
}

func connectionLogValue(config *sdk.MCPClientConfig) connectionLog {
	switch transport := config.Transport.(type) {
	case *mcpsdk.StreamableClientTransport:
		connection := connectionLog{Transport: "http", Endpoint: transport.Endpoint}
		if transport.HTTPClient != nil {
			if configuredTransport, ok := transport.HTTPClient.Transport.(mcpHTTPTransport); ok {
				connection.Headers = configuredTransport.headers
			}
		}
		return connection
	case *mcpsdk.CommandTransport:
		command := transport.Command
		if command == nil {
			return connectionLog{Transport: "stdio"}
		}
		return connectionLog{
			Transport:        "stdio",
			Command:          command.Path,
			Args:             slices.Clone(command.Args),
			WorkingDirectory: command.Dir,
			Environment:      slices.Clone(command.Env),
		}
	default:
		return connectionLog{Transport: fmt.Sprintf("%T", config.Transport)}
	}
}

func expandHeaders(headers map[string]string) (map[string]string, error) {
	expanded, err := expandMap(headers, false)
	if err != nil {
		return nil, err
	}
	canonical := make(map[string]string, len(expanded))
	for name, value := range expanded {
		canonicalName := textproto.CanonicalMIMEHeaderKey(name)
		if canonicalName == "" {
			return nil, fmt.Errorf("invalid HTTP header name %q", name)
		}
		if _, exists := canonical[canonicalName]; exists {
			return nil, fmt.Errorf("duplicate HTTP header name %q", canonicalName)
		}
		canonical[canonicalName] = value
	}
	return canonical, nil
}

func expandMap(values map[string]string, environmentKeys bool) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	expanded := make(map[string]string, len(values))
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			return nil, errors.New("empty key")
		}
		if environmentKeys && !environmentNamePattern.MatchString(key) {
			return nil, fmt.Errorf("invalid environment variable name %q", key)
		}
		expandedValue, err := expandEnvironment(value)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", key, err)
		}
		expanded[key] = expandedValue
	}
	return expanded, nil
}

func expandEnvironment(value string) (string, error) {
	var expandErr error
	expanded := environmentReferencePattern.ReplaceAllStringFunc(value, func(reference string) string {
		name := reference[2 : len(reference)-1]
		value, exists := os.LookupEnv(name)
		if !exists && expandErr == nil {
			expandErr = fmt.Errorf("environment variable %s is not set", name)
		}
		return value
	})
	if expandErr != nil {
		return "", expandErr
	}
	return expanded, nil
}

func sortedEnvironment(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, key+"="+environment[key])
	}
	return values
}

type mcpHTTPTransport struct {
	base    http.RoundTripper
	headers map[string]string
}

func (t mcpHTTPTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if len(t.headers) > 0 {
		request = request.Clone(request.Context())
		request.Header = request.Header.Clone()
		for name, value := range t.headers {
			request.Header.Set(name, value)
		}
	}
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if request.Method != http.MethodDelete || response.StatusCode >= 200 && response.StatusCode < 300 ||
		response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusMethodNotAllowed {
		return response, nil
	}
	_, copyErr := io.Copy(io.Discard, response.Body)
	closeErr := response.Body.Close()
	statusErr := fmt.Errorf("mcp session delete returned HTTP status %s", response.Status)
	return nil, errors.Join(statusErr, copyErr, closeErr)
}

func (s *Set) Tools() []sdk.Tool {
	return slices.Clone(s.tools)
}

func (s *Set) Close() error {
	s.closeOnce.Do(func() {
		slog.Debug("Closing MCP clients", "clients", len(s.clients))
		var closeErrors []error
		for _, mcpClient := range slices.Backward(s.clients) {
			if err := mcpClient.Close(); err != nil {
				closeErrors = append(closeErrors, err)
			}
		}
		s.closeErr = errors.Join(closeErrors...)
		slog.Debug("Closed MCP clients", "err", s.closeErr)
	})
	return s.closeErr
}

func closeOnError(set *Set, err error) error {
	if closeErr := set.Close(); closeErr != nil {
		return errors.Join(err, fmt.Errorf("close MCP clients: %w", closeErr))
	}
	return err
}
