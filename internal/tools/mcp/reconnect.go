package mcp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/felinics/twilight/sdk"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

var (
	mcpRetryInitial = 200 * time.Millisecond
	mcpRetryMax     = 5 * time.Second
)

// mcpConnection keeps one MCP session. Startup dials until the server is up.
// A later network failure replaces the session without changing the tool list
// already published to the model.
type mcpConnection struct {
	server           Server
	workingDirectory string
	create           clientFactory

	mu          sync.Mutex
	reconnectMu sync.Mutex
	client      client
	calls       map[string]sdk.ToolExecuteFunc
	closed      bool
}

func connectMCP(
	ctx context.Context,
	server Server,
	workingDirectory string,
	create clientFactory,
) (*mcpConnection, []sdk.Tool, error) {
	connection := &mcpConnection{
		server:           server,
		workingDirectory: workingDirectory,
		create:           create,
	}
	tools, err := connection.dial(ctx)
	if err != nil {
		closeErr := connection.Close()
		return nil, nil, errors.Join(err, closeErr)
	}
	return connection, tools, nil
}

func (c *mcpConnection) Tools(ctx context.Context) ([]sdk.Tool, error) {
	c.mu.Lock()
	current := c.client
	closed := c.closed
	c.mu.Unlock()
	if closed || current == nil {
		return nil, errors.New("mcp client is closed")
	}
	return current.Tools(ctx)
}

func (c *mcpConnection) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.client == nil {
		return nil
	}
	err := c.client.Close()
	c.client = nil
	c.calls = nil
	return err
}

func (c *mcpConnection) bind(originalName string) sdk.ToolExecuteFunc {
	return func(ctx *sdk.ToolExecContext, input any) (any, error) {
		output, err := c.invoke(ctx, originalName, input)
		if err == nil || !transientMCPError(err) {
			return output, err
		}
		callCtx := toolContext(ctx)
		if callCtx.Err() != nil {
			return output, err
		}
		c.reconnectMu.Lock()
		defer c.reconnectMu.Unlock()
		output, err = c.invoke(ctx, originalName, input)
		if err == nil || !transientMCPError(err) || callCtx.Err() != nil {
			return output, err
		}
		slog.WarnContext(callCtx, "Reconnecting MCP server", "server", c.server.Name, "error", err)
		if _, reconnectErr := c.dial(callCtx); reconnectErr != nil {
			return nil, fmt.Errorf("reconnect MCP server %q: %w", strings.TrimSpace(c.server.Name), reconnectErr)
		}
		return c.invoke(ctx, originalName, input)
	}
}

func (c *mcpConnection) invoke(ctx *sdk.ToolExecContext, originalName string, input any) (any, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("MCP server %q is closed", strings.TrimSpace(c.server.Name))
	}
	call := c.calls[originalName]
	c.mu.Unlock()
	if call == nil {
		return nil, fmt.Errorf("MCP server %q has no tool %q", strings.TrimSpace(c.server.Name), originalName)
	}
	return call(ctx, input)
}

func (c *mcpConnection) dial(ctx context.Context) ([]sdk.Tool, error) {
	var delay time.Duration
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if delay > 0 {
			if err := waitForMCPRetry(ctx, delay); err != nil {
				return nil, err
			}
		}
		tools, err := c.connectOnce(ctx)
		if err == nil {
			return tools, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !transientMCPError(err) {
			return nil, err
		}
		delay = nextMCPRetryDelay(delay)
		slog.WarnContext(ctx, "MCP connection failed; retrying", "server", c.server.Name, "error", err, "delay", delay)
	}
}

func (c *mcpConnection) connectOnce(ctx context.Context) ([]sdk.Tool, error) {
	config, err := clientConfig(c.server, c.workingDirectory)
	if err != nil {
		return nil, err
	}
	slog.DebugContext(ctx, "Connecting MCP server", "server", c.server.Name, "connection", connectionLogValue(config))
	mcpClient, err := c.create(ctx, config)
	if err != nil {
		return nil, err
	}
	remoteTools, err := mcpClient.Tools(ctx)
	if err != nil {
		return nil, errors.Join(err, mcpClient.Close())
	}
	calls := make(map[string]sdk.ToolExecuteFunc, len(remoteTools))
	for _, tool := range remoteTools {
		calls[tool.Name] = tool.Execute
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errors.Join(errors.New("mcp client is closed"), mcpClient.Close())
	}
	previous := c.client
	c.client = mcpClient
	c.calls = calls
	c.mu.Unlock()
	if previous != nil {
		if err := previous.Close(); err != nil {
			slog.WarnContext(ctx, "Close previous MCP client", "server", c.server.Name, "error", err)
		}
	}
	return remoteTools, nil
}

func transientMCPError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, mcpsdk.ErrConnectionClosed) || errors.Is(err, mcpsdk.ErrSessionMissing) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ETIMEDOUT) {
		return true
	}
	var networkErr net.Error
	return errors.As(err, &networkErr)
}

func nextMCPRetryDelay(current time.Duration) time.Duration {
	if current <= 0 {
		return mcpRetryInitial
	}
	next := current * 2
	if next <= current || next > mcpRetryMax {
		return mcpRetryMax
	}
	return next
}

func waitForMCPRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func toolContext(ctx *sdk.ToolExecContext) context.Context {
	if ctx != nil && ctx.Context != nil {
		return ctx.Context
	}
	return context.Background()
}
