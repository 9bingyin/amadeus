package agent

import (
	"context"
	"errors"
	"io"
	"net"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/felinics/twilight/sdk"
)

type RetryConfig struct {
	Enabled       bool
	MaxRetries    int
	BaseDelay     time.Duration
	MaxAgentDelay time.Duration
}

var (
	nonRetryableProviderErrorPattern = buildProviderErrorPattern([]string{
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"billing",
	})
	retryableProviderErrorPattern = buildProviderErrorPattern([]string{
		"overloaded",
		"currently experiencing high demand",
		"rate.?limit",
		"too many requests",
		`\b429\b`,
		`\b500\b`,
		`\b502\b`,
		`\b503\b`,
		`\b504\b`,
		`\b520\b`,
		`\b524\b`,
		"service.?unavailable",
		"server.?error",
		"internal.?error",
		"provider.?returned.?error",
		"exceeded request buffer limit while retrying upstream",
		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"other side closed",
		"fetch failed",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed? out",
		"timeout",
		"terminated",
		"websocket.?closed",
		"websocket.?error",
		"ended without",
		"stream ended before message_stop",
		"stream ended before a terminal response event",
		"http2 request did not get a response",
		"retry delay",
		"you can retry your request",
		"try your request again",
		"please retry your request",
		"ResourceExhausted",
		"protocol.?error",
		"stream.?error",
	})
)

func buildProviderErrorPattern(patterns []string) *regexp.Regexp {
	return regexp.MustCompile("(?i)(?:" + strings.Join(patterns, "|") + ")")
}

type modelRequestError struct {
	err error
}

func (e *modelRequestError) Error() string {
	return e.err.Error()
}

func (e *modelRequestError) Unwrap() error {
	return e.err
}

type modelRequestProvider struct {
	sdk.Provider
}

func (p modelRequestProvider) DoGenerate(ctx context.Context, params sdk.GenerateParams) (*sdk.GenerateResult, error) {
	result, err := p.Provider.DoGenerate(ctx, params)
	if err != nil {
		return nil, &modelRequestError{err: err}
	}
	return result, nil
}

func (p modelRequestProvider) DoStream(ctx context.Context, params sdk.GenerateParams) (*sdk.StreamResult, error) {
	result, err := p.Provider.DoStream(ctx, params)
	if err != nil {
		return nil, &modelRequestError{err: err}
	}
	return result, nil
}

func modelWithRequestErrors(model *sdk.Model) *sdk.Model {
	wrapped := *model
	wrapped.Provider = modelRequestProvider{Provider: model.Provider}
	return &wrapped
}

func isRetryableModelRequest(ctx context.Context, err error) bool {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return false
	}
	var requestErr *modelRequestError
	if !errors.As(err, &requestErr) {
		return false
	}
	message := requestErr.Error()
	if nonRetryableProviderErrorPattern.MatchString(message) {
		return false
	}
	if errors.Is(requestErr, io.EOF) || errors.Is(requestErr, io.ErrUnexpectedEOF) ||
		errors.Is(requestErr, syscall.ECONNRESET) || errors.Is(requestErr, syscall.ECONNREFUSED) ||
		errors.Is(requestErr, syscall.EPIPE) {
		return true
	}
	var networkErr net.Error
	if errors.As(requestErr, &networkErr) && networkErr.Timeout() {
		return true
	}
	return retryableProviderErrorPattern.MatchString(message)
}

func retryDelay(config RetryConfig, attempt int) time.Duration {
	if attempt < 1 || config.BaseDelay <= 0 || config.MaxAgentDelay <= 0 {
		return 0
	}
	delay := config.BaseDelay
	if delay >= config.MaxAgentDelay {
		return config.MaxAgentDelay
	}
	for range attempt - 1 {
		if delay >= config.MaxAgentDelay-delay {
			return config.MaxAgentDelay
		}
		delay *= 2
	}
	return delay
}

func waitForRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
