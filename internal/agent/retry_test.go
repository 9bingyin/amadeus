package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"syscall"
	"testing"
	"time"
)

func TestIsRetryableModelRequest(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "protocol error", err: &modelRequestError{err: errors.New("stream error: PROTOCOL_ERROR")}, want: true},
		{name: "rate limit", err: &modelRequestError{err: errors.New("429 too many requests")}, want: true},
		{name: "network", err: &modelRequestError{err: errors.New("connection reset before headers")}, want: true},
		{name: "unexpected eof", err: &modelRequestError{err: fmt.Errorf("decode response: %w", io.ErrUnexpectedEOF)}, want: true},
		{name: "connection reset", err: &modelRequestError{err: fmt.Errorf("read tcp: %w", syscall.ECONNRESET)}, want: true},
		{name: "billing takes precedence", err: &modelRequestError{err: errors.New("429 insufficient_quota billing")}},
		{name: "invalid request", err: &modelRequestError{err: errors.New("400 invalid request")}},
		{name: "status substring", err: &modelRequestError{err: errors.New("400 maximum context length: requested 150000 tokens")}},
		{name: "non-model error", err: errors.New("503 service unavailable")},
		{name: "canceled", err: &modelRequestError{err: context.Canceled}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isRetryableModelRequest(t.Context(), test.err); got != test.want {
				t.Fatalf("isRetryableModelRequest() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestIsRetryableModelRequestHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if isRetryableModelRequest(ctx, &modelRequestError{err: errors.New("503 service unavailable")}) {
		t.Fatal("isRetryableModelRequest() = true for canceled context")
	}
}

func TestWaitForRetryIsCancelable(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	result := make(chan error, 1)
	go func() {
		result <- waitForRetry(ctx, time.Hour)
	}()
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("waitForRetry() error = %v, want context canceled", err)
	}
}

func TestRetryDelay(t *testing.T) {
	config := RetryConfig{BaseDelay: 2 * time.Second, MaxAgentDelay: 5 * time.Second}
	for _, test := range []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 0, want: 0},
		{attempt: 1, want: 2 * time.Second},
		{attempt: 2, want: 4 * time.Second},
		{attempt: 3, want: 5 * time.Second},
		{attempt: 100, want: 5 * time.Second},
	} {
		if got := retryDelay(config, test.attempt); got != test.want {
			t.Fatalf("retryDelay(attempt %d) = %s, want %s", test.attempt, got, test.want)
		}
	}
}
