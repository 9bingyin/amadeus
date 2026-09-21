package agent

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/felinics/twilight/sdk"
)

func TestHasIncompleteToolStep(t *testing.T) {
	if !hasIncompleteToolStep(&sdk.StepResult{ToolCalls: []sdk.ToolCall{{ToolCallID: "call-1"}}}) {
		t.Fatal("tool call without result was not incomplete")
	}
	if hasIncompleteToolStep(&sdk.StepResult{
		ToolCalls:   []sdk.ToolCall{{ToolCallID: "call-1"}},
		ToolResults: []sdk.ToolResult{{ToolCallID: "call-1"}},
	}) {
		t.Fatal("completed tool step was marked incomplete")
	}
	if hasIncompleteToolStep(&sdk.StepResult{Messages: []sdk.Message{sdk.AssistantMessage("done")}}) {
		t.Fatal("ordinary final step was marked incomplete")
	}
}

func TestRunStoredInterruptsModelRequestAndPreservesToolStep(t *testing.T) {
	requestStarted := make(chan struct{})
	provider := &interruptSequenceProvider{requestStarted: requestStarted}

	echo := sdk.NewTool("echo", "echo input", func(_ *sdk.ToolExecContext, input struct {
		Text string `json:"text"`
	}) (any, error) {
		return input.Text, nil
	})
	loop := &Loop{model: &sdk.Model{ID: "test", Provider: provider}, tools: []sdk.Tool{echo}}
	conversation := newInterruptTestConversation()
	result := make(chan struct {
		reply string
		err   error
	}, 1)
	go func() {
		reply, err := loop.RunStored(
			t.Context(), []sdk.Message{sdk.UserMessage("first")}, conversation,
		)
		result <- struct {
			reply string
			err   error
		}{reply: reply, err: err}
	}()

	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("second model request did not start")
	}
	conversation.add(sdk.UserMessage("second"))
	select {
	case completed := <-result:
		if completed.err != nil {
			t.Fatalf("RunStored() error = %v", completed.err)
		}
		if completed.reply != "done" {
			t.Fatalf("RunStored() reply = %q", completed.reply)
		}
	case <-time.After(time.Second):
		t.Fatal("RunStored() did not resume after interruption")
	}
	if provider.calls.Load() != 3 {
		t.Fatalf("provider calls = %d, want 3", provider.calls.Load())
	}
}

func TestRunStoredSupersedesProviderErrorAfterPersistedInput(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	provider := &staleErrorProvider{requestStarted: requestStarted, releaseRequest: releaseRequest}
	loop := &Loop{model: &sdk.Model{ID: "test", Provider: provider}}
	conversation := newInterruptTestConversation()
	result := make(chan error, 1)
	go func() {
		reply, err := loop.RunStored(
			t.Context(), []sdk.Message{sdk.UserMessage("first")}, conversation,
		)
		if err == nil && reply != "done" {
			err = fmt.Errorf("reply = %q", reply)
		}
		result <- err
	}()

	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("model request did not start")
	}
	conversation.addWithoutSignal(sdk.UserMessage("second"))
	close(releaseRequest)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("RunStored() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("RunStored() did not recover from stale provider error")
	}
	if provider.calls.Load() != 2 {
		t.Fatalf("provider calls = %d, want 2", provider.calls.Load())
	}
}

type staleErrorProvider struct {
	calls          atomic.Int32
	requestStarted chan struct{}
	releaseRequest chan struct{}
}

func (*staleErrorProvider) Name() string {
	return "stale-error"
}

func (*staleErrorProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}

func (*staleErrorProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}

func (*staleErrorProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}

func (p *staleErrorProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		close(p.requestStarted)
		<-p.releaseRequest
		return nil, errors.New("deterministic provider failure")
	case 2:
		if got := userTexts(params.Messages); !equalStrings(got, []string{"first", "second"}) {
			return nil, fmt.Errorf("user messages = %#v", got)
		}
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}

func (*staleErrorProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

func TestRunStoredDefersNewInputUntilToolStepCompletes(t *testing.T) {
	toolStarted := make(chan struct{})
	releaseTool := make(chan struct{})
	provider := &toolBoundaryProvider{}
	tool := sdk.NewTool("wait", "wait for release", func(ctx *sdk.ToolExecContext, _ struct{}) (any, error) {
		close(toolStarted)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-releaseTool:
			return "completed tool", nil
		}
	})
	loop := &Loop{model: &sdk.Model{ID: "test", Provider: provider}, tools: []sdk.Tool{tool}}
	conversation := newInterruptTestConversation()
	result := make(chan error, 1)
	go func() {
		reply, err := loop.RunStored(
			t.Context(), []sdk.Message{sdk.UserMessage("first")}, conversation,
		)
		if err == nil && reply != "done" {
			err = fmt.Errorf("reply = %q", reply)
		}
		result <- err
	}()

	select {
	case <-toolStarted:
	case <-time.After(time.Second):
		t.Fatal("tool did not start")
	}
	conversation.add(sdk.UserMessage("second"))
	close(releaseTool)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("RunStored() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("RunStored() did not finish after tool release")
	}
	if provider.calls.Load() != 2 {
		t.Fatalf("provider calls = %d, want 2", provider.calls.Load())
	}
}

type toolBoundaryProvider struct {
	calls atomic.Int32
}

func (*toolBoundaryProvider) Name() string {
	return "tool-boundary"
}

func (*toolBoundaryProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}

func (*toolBoundaryProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}

func (*toolBoundaryProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}

func (p *toolBoundaryProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		return &sdk.GenerateResult{
			FinishReason: sdk.FinishReasonToolCalls,
			ToolCalls: []sdk.ToolCall{{
				ToolCallID: "call-1", ToolName: "wait", Input: map[string]any{},
			}},
		}, nil
	case 2:
		if got := userTexts(params.Messages); !equalStrings(got, []string{"first", "second"}) {
			return nil, fmt.Errorf("user messages = %#v", got)
		}
		if !hasToolResult(params.Messages, "completed tool") {
			return nil, errors.New("completed tool result is missing")
		}
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}

func (*toolBoundaryProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type interruptSequenceProvider struct {
	calls          atomic.Int32
	requestStarted chan struct{}
}

func (*interruptSequenceProvider) Name() string {
	return "interrupt-sequence"
}

func (*interruptSequenceProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}

func (*interruptSequenceProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}

func (*interruptSequenceProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}

func (p *interruptSequenceProvider) DoGenerate(
	ctx context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		return &sdk.GenerateResult{
			FinishReason: sdk.FinishReasonToolCalls,
			ToolCalls: []sdk.ToolCall{{
				ToolCallID: "call-1", ToolName: "echo", Input: map[string]any{"text": "tool output"},
			}},
		}, nil
	case 2:
		close(p.requestStarted)
		<-ctx.Done()
		return nil, ctx.Err()
	case 3:
		if got := userTexts(params.Messages); !equalStrings(got, []string{"first", "second"}) {
			return nil, fmt.Errorf("user messages = %#v", got)
		}
		if !hasToolResult(params.Messages, "tool output") {
			return nil, errors.New("committed tool result is missing")
		}
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}

func (*interruptSequenceProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type interruptTestConversation struct {
	mu       sync.Mutex
	revision int64
	handled  int64
	pending  []sdk.Message
	changed  chan struct{}
}

func newInterruptTestConversation() *interruptTestConversation {
	return &interruptTestConversation{revision: 1, handled: 1, changed: make(chan struct{})}
}

func (c *interruptTestConversation) add(message sdk.Message) {
	c.mu.Lock()
	c.revision++
	c.pending = append(c.pending, message)
	close(c.changed)
	c.changed = make(chan struct{})
	c.mu.Unlock()
}

func (c *interruptTestConversation) addWithoutSignal(message sdk.Message) {
	c.mu.Lock()
	c.revision++
	c.pending = append(c.pending, message)
	c.mu.Unlock()
}

func (c *interruptTestConversation) PrepareRequest(context.Context) (StoredInput, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	messages := append([]sdk.Message(nil), c.pending...)
	c.pending = nil
	c.handled = c.revision
	return StoredInput{Messages: messages, InputRevision: c.revision}, nil
}

func (c *interruptTestConversation) WatchInput(afterRevision int64) <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revision > afterRevision {
		ready := make(chan struct{})
		close(ready)
		return ready
	}
	return c.changed
}

func (c *interruptTestConversation) InputCurrent(
	_ context.Context,
	inputRevision int64,
) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.revision == inputRevision, nil
}

func (c *interruptTestConversation) AdmitResponse(
	_ context.Context,
	_, inputRevision int64,
) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.revision == inputRevision, nil
}

func (c *interruptTestConversation) CommitStep(
	_ context.Context,
	_ *sdk.StepResult,
	final bool,
) (StoredStep, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return StoredStep{Sealed: final && c.revision == c.handled}, nil
}
