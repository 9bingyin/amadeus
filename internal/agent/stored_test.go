package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/felinics/twilight/sdk"
)

func TestHasIncompleteToolStep(t *testing.T) {
	tests := []struct {
		name string
		step sdk.StepResult
		want bool
	}{
		{
			name: "missing all results",
			step: sdk.StepResult{ToolCalls: []sdk.ToolCall{{ToolCallID: "call-1"}}},
			want: true,
		},
		{
			name: "missing one result",
			step: sdk.StepResult{
				ToolCalls:   []sdk.ToolCall{{ToolCallID: "call-1"}, {ToolCallID: "call-2"}},
				ToolResults: []sdk.ToolResult{{ToolCallID: "call-1"}},
			},
			want: true,
		},
		{
			name: "mismatched result",
			step: sdk.StepResult{
				ToolCalls:   []sdk.ToolCall{{ToolCallID: "call-1"}},
				ToolResults: []sdk.ToolResult{{ToolCallID: "call-2"}},
			},
			want: true,
		},
		{
			name: "complete tool step",
			step: sdk.StepResult{
				ToolCalls:   []sdk.ToolCall{{ToolCallID: "call-1"}},
				ToolResults: []sdk.ToolResult{{ToolCallID: "call-1"}},
			},
		},
		{
			name: "ordinary final step",
			step: sdk.StepResult{Messages: []sdk.Message{sdk.AssistantMessage("done")}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasIncompleteToolStep(&tt.step); got != tt.want {
				t.Fatalf("hasIncompleteToolStep() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestRunStoredReadImageReachesModel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "picture.jpg")
	if err := os.WriteFile(path, []byte("image bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := &providerFunc{generate: func(call int, params sdk.GenerateParams) (*sdk.GenerateResult, error) {
		switch call {
		case 1:
			return &sdk.GenerateResult{
				FinishReason: sdk.FinishReasonToolCalls,
				ToolCalls:    []sdk.ToolCall{{ToolCallID: "read-1", ToolName: "read", Input: map[string]any{"path": path}}},
			}, nil
		case 2:
			if !hasToolResult(params.Messages, "Read image file [image/jpeg]") {
				t.Fatal("read tool result missing image note")
			}
			for _, message := range params.Messages {
				if message.Role != sdk.MessageRoleUser {
					continue
				}
				for _, part := range message.Content {
					if image, ok := part.(sdk.ImagePart); ok {
						if image.Image != "data:image/jpeg;base64,aW1hZ2UgYnl0ZXM=" {
							t.Fatalf("image sent to model = %#v", image)
						}
						return &sdk.GenerateResult{Text: "seen", FinishReason: sdk.FinishReasonStop}, nil
					}
				}
			}
			t.Fatal("model did not receive read image")
		}
		return nil, errors.New("unexpected model call")
	}}
	read := sdk.NewTool("read", "test read", func(_ *sdk.ToolExecContext, _ struct{}) (any, error) {
		return sdk.ImagePart{Image: FileURL(path), MediaType: "image/jpeg"}, nil
	})
	loop := &Loop{
		model: &sdk.Model{ID: "test", Provider: provider},
		input: ModelInput{Text: true, Image: true},
		tools: []sdk.Tool{read},
	}
	reply, err := loop.RunStored(t.Context(), []sdk.Message{sdk.UserMessage("read image")}, newInterruptTestConversation())
	if err != nil || reply != "seen" {
		t.Fatalf("RunStored() = %q, %v; want seen", reply, err)
	}
}

func TestRunStoredReplaysReadImageFromHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "picture.jpg")
	if err := os.WriteFile(path, []byte("image bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	toolResult := sdk.ToolMessage(sdk.ToolResultPart{
		ToolCallID: "read-1", ToolName: "read",
		Result: map[string]any{"image": FileURL(path), "mediaType": "image/jpeg"},
	})
	history := []sdk.Message{
		sdk.UserMessage("read image"),
		{Role: sdk.MessageRoleAssistant, Content: []sdk.MessagePart{sdk.ToolCallPart{
			ToolCallID: "read-1", ToolName: "read", Input: map[string]any{"path": path},
		}}},
		toolResult,
	}
	provider := &providerFunc{generate: func(call int, params sdk.GenerateParams) (*sdk.GenerateResult, error) {
		if call != 1 || !hasToolResult(params.Messages, "Read image file [image/jpeg]") {
			t.Fatalf("replayed tool result = %#v", params.Messages)
		}
		for _, message := range params.Messages {
			for _, part := range message.Content {
				if image, ok := part.(sdk.ImagePart); ok {
					if image.Image != "data:image/jpeg;base64,aW1hZ2UgYnl0ZXM=" {
						t.Fatalf("replayed image = %#v", image)
					}
					return &sdk.GenerateResult{Text: "seen", FinishReason: sdk.FinishReasonStop}, nil
				}
			}
		}
		return nil, errors.New("replayed image not sent to model")
	}}
	loop := &Loop{model: &sdk.Model{ID: "test", Provider: provider}, input: ModelInput{Text: true, Image: true}}
	reply, err := loop.RunStored(t.Context(), history, newInterruptTestConversation())
	if err != nil || reply != "seen" {
		t.Fatalf("RunStored() = %q, %v; want seen", reply, err)
	}
	if got := toolResult.Content[0].(sdk.ToolResultPart).Result.(map[string]any)["image"]; got != FileURL(path) {
		t.Fatalf("stored history was mutated: %q", got)
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

func TestRunStoredResetsToolProgressAfterNewInput(t *testing.T) {
	var mu sync.Mutex
	var events []string
	ctx := WithToolRun(t.Context(), ToolRun{
		ID: "run-1", Platform: "telegram", ChatID: "100",
		Notify: func(_ context.Context, activity ToolActivity) {
			mu.Lock()
			events = append(events, fmt.Sprintf("tool:%d:%s", activity.InputRevision, activity.Name))
			mu.Unlock()
		},
		ResetProgress: func(_ context.Context, activity ToolActivity) {
			mu.Lock()
			events = append(events, fmt.Sprintf("reset:%d", activity.InputRevision))
			mu.Unlock()
		},
	})
	echo := sdk.NewTool("echo", "echo input", func(_ *sdk.ToolExecContext, input struct {
		Text string `json:"text"`
	}) (any, error) {
		return input.Text, nil
	})
	loop := &Loop{
		model: &sdk.Model{ID: "test", Provider: &progressRevisionProvider{}},
		tools: toolsWithLogging([]sdk.Tool{echo}),
	}
	conversation := &bumpingInputConversation{interruptTestConversation: newInterruptTestConversation()}
	reply, err := loop.RunStored(ctx, []sdk.Message{sdk.UserMessage("first")}, conversation)
	if err != nil {
		t.Fatalf("RunStored() error = %v", err)
	}
	if reply != "done" {
		t.Fatalf("RunStored() reply = %q", reply)
	}
	want := []string{"tool:1:echo", "reset:2", "tool:2:echo"}
	if !equalStrings(events, want) {
		t.Fatalf("events = %#v, want %#v", events, want)
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

type progressRevisionProvider struct {
	calls atomic.Int32
}

func (*progressRevisionProvider) Name() string { return "progress-revision" }
func (*progressRevisionProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}
func (*progressRevisionProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*progressRevisionProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *progressRevisionProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1, 2:
		return &sdk.GenerateResult{
			FinishReason: sdk.FinishReasonToolCalls,
			ToolCalls: []sdk.ToolCall{{
				ToolCallID: fmt.Sprintf("call-%d", call), ToolName: "echo",
				Input: map[string]any{"text": "tool output"},
			}},
		}, nil
	case 3:
		if got := userTexts(params.Messages); !equalStrings(got, []string{"first", "second"}) {
			return nil, fmt.Errorf("user messages = %#v", got)
		}
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*progressRevisionProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type bumpingInputConversation struct {
	*interruptTestConversation
	bumped bool
}

func (c *bumpingInputConversation) CommitStep(
	_ context.Context,
	_ *sdk.StepResult,
	final bool,
) (StoredStep, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !final && !c.bumped {
		c.bumped = true
		c.revision++
		c.pending = append(c.pending, sdk.UserMessage("second"))
	}
	return StoredStep{Sealed: final && c.revision == c.handled}, nil
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

func (*interruptTestConversation) CommitCheckpoint(
	context.Context,
	StoredCheckpoint,
) (StoredCheckpointResult, error) {
	return StoredCheckpointResult{Applied: true}, nil
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
