package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/felinics/twilight/sdk"
)

func TestShouldCompactUsesStrictPiThreshold(t *testing.T) {
	loop := &Loop{compaction: CompactionConfig{
		Enabled: true, ContextWindowTokens: 100, ReserveTokens: 20,
	}}
	usage := sdk.Usage{TotalTokens: 80}
	message := sdk.AssistantMessage("at threshold")
	message.Usage = &usage
	if estimated, compact := loop.shouldCompact([]sdk.Message{message}); estimated != 80 || compact {
		t.Fatalf("at threshold = %d, %t; want 80, false", estimated, compact)
	}
	usage.TotalTokens = 81
	if estimated, compact := loop.shouldCompact([]sdk.Message{message}); estimated != 81 || !compact {
		t.Fatalf("above threshold = %d, %t; want 81, true", estimated, compact)
	}
}

func TestEstimateContextTokensUsesLatestUsageAndTrailingMessages(t *testing.T) {
	usage := sdk.Usage{InputTokens: 80, OutputTokens: 20, TotalTokens: 100}
	assistant := sdk.AssistantMessage("answer")
	assistant.Usage = &usage
	trailing := sdk.ToolMessage(sdk.ToolResultPart{
		ToolCallID: "call-1", ToolName: "read", Result: strings.Repeat("x", 80),
	})
	messages := []sdk.Message{
		sdk.UserMessage(strings.Repeat("ignored", 100)),
		assistant,
		trailing,
	}
	want := 100 + estimateMessageTokens(trailing)
	if got := estimateContextTokens(strings.Repeat("system", 100), nil, messages); got != want {
		t.Fatalf("estimateContextTokens() = %d, want %d", got, want)
	}
}

func TestEstimateMessageTokensDoesNotCountAttachmentBase64AsText(t *testing.T) {
	message := sdk.Message{
		Role: sdk.MessageRoleUser,
		Content: []sdk.MessagePart{sdk.ImagePart{
			Image: strings.Repeat("A", 1024*1024), MediaType: "image/png",
		}},
	}
	if got := estimateMessageTokens(message); got > estimatedAttachmentTokens+20 {
		t.Fatalf("attachment estimate = %d, want near %d", got, estimatedAttachmentTokens)
	}
}

func TestSplitCompactionHistoryKeepsToolExchangeAtomic(t *testing.T) {
	toolCall := sdk.Message{
		Role: sdk.MessageRoleAssistant,
		Content: []sdk.MessagePart{sdk.ToolCallPart{
			ToolCallID: "call-1", ToolName: "read", Input: map[string]any{"path": "file.go"},
		}},
	}
	toolResult := sdk.ToolMessage(sdk.ToolResultPart{
		ToolCallID: "call-1", ToolName: "read", Result: "content",
	})
	latest := sdk.UserMessage("continue")
	messages := []sdk.Message{sdk.UserMessage("old"), toolCall, toolResult, latest}
	keep := estimateMessageTokens(latest) + 1
	source, tail, ok := splitCompactionHistory(messages, keep, 1_000_000)
	if !ok {
		t.Fatal("splitCompactionHistory() did not find a compactable prefix")
	}
	if len(source) != 1 || len(tail) != 3 {
		t.Fatalf("split lengths = %d/%d, want 1/3", len(source), len(tail))
	}
	if tail[0].Role != sdk.MessageRoleAssistant || tail[1].Role != sdk.MessageRoleTool {
		t.Fatalf("tool exchange was split: %#v", tail)
	}
}

func TestSplitCompactionHistorySummarizesOversizedTail(t *testing.T) {
	huge := sdk.ToolMessage(sdk.ToolResultPart{
		ToolCallID: "call-1", ToolName: "search", Result: strings.Repeat("x", 4000),
	})
	source, tail, ok := splitCompactionHistory(
		[]sdk.Message{sdk.UserMessage("older"), huge}, 10, 100,
	)
	if !ok || len(tail) != 0 || len(source) != 2 {
		t.Fatalf("split = %d/%d ok=%t, want 2/0 true", len(source), len(tail), ok)
	}
}

func TestCompactContextBuildsManualCheckpointWithoutTools(t *testing.T) {
	provider := &compactionTestProvider{}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 120, ReserveTokens: 20, KeepRecentTokens: 10,
		},
	}
	result, err := loop.CompactContext(t.Context(), []sdk.Message{
		sdk.UserMessage(strings.Repeat("a", 240)),
		sdk.AssistantMessage(strings.Repeat("b", 240)),
		sdk.UserMessage("latest request"),
	})
	if err != nil {
		t.Fatalf("CompactContext() error = %v", err)
	}
	if provider.calls.Load() != 1 || result.SummaryModel != "test-model" ||
		result.SummaryPromptVersion != summaryPromptVersion || len(result.Replacement) < 2 ||
		result.EstimatedTokensAfter >= result.EstimatedTokensBefore {
		t.Fatalf("manual compaction = %#v, calls %d", result, provider.calls.Load())
	}
}

func TestCompactContextNotifiesWhileSummarizing(t *testing.T) {
	var events []bool
	active := false
	ctx := WithToolRun(t.Context(), ToolRun{
		ID: "run-1", Platform: "telegram", ChatID: "42", ThreadID: "7",
		NotifyCompaction: func(_ context.Context, activity CompactionActivity, started bool) {
			if activity.RunID != "run-1" || activity.ChatID != "42" || activity.ThreadID != "7" {
				t.Fatalf("activity = %#v", activity)
			}
			active = started
			events = append(events, started)
		},
	})
	provider := &noticeProvider{active: &active}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 120, ReserveTokens: 20, KeepRecentTokens: 10,
		},
	}
	history := []sdk.Message{
		sdk.UserMessage(strings.Repeat("a", 240)),
		sdk.AssistantMessage(strings.Repeat("b", 240)),
		sdk.UserMessage("latest request"),
	}
	if _, err := loop.CompactContext(ctx, history); err != nil {
		t.Fatalf("CompactContext() error = %v", err)
	}
	if !provider.saw || len(events) != 2 || !events[0] || events[1] {
		t.Fatalf("events = %v, saw = %t", events, provider.saw)
	}
	if active {
		t.Fatal("compaction notice stayed active")
	}

	provider = &noticeProvider{active: &active, fail: true}
	events = nil
	loop.model = &sdk.Model{ID: "test-model", Provider: provider}
	if _, err := loop.CompactContext(ctx, history); err == nil {
		t.Fatal("CompactContext() error = nil, want summary failure")
	}
	if !provider.saw || len(events) != 2 || events[0] != true || events[1] != false || active {
		t.Fatalf("failed events = %v, active = %t, saw = %t", events, active, provider.saw)
	}
}

func TestRunStoredCompactsBeforeProviderRequest(t *testing.T) {
	provider := &compactionTestProvider{}
	conversation := &compactionTestConversation{}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 120, ReserveTokens: 20, KeepRecentTokens: 10,
		},
	}
	history := []sdk.Message{
		sdk.UserMessage(strings.Repeat("a", 240)),
		sdk.AssistantMessage(strings.Repeat("b", 240)),
		sdk.UserMessage("latest request"),
	}
	reply, err := loop.RunStored(t.Context(), history, conversation)
	if err != nil {
		t.Fatalf("RunStored() error = %v", err)
	}
	if reply != "done" {
		t.Fatalf("RunStored() reply = %q, want done", reply)
	}
	if provider.calls.Load() != 2 {
		t.Fatalf("provider calls = %d, want 2", provider.calls.Load())
	}
	if conversation.checkpoint.Cause != "threshold" || len(conversation.checkpoint.Replacement) < 2 {
		t.Fatalf("checkpoint = %#v", conversation.checkpoint)
	}
	if text := conversation.checkpoint.Replacement[0].Content[0].(sdk.TextPart).Text; !strings.HasPrefix(text, checkpointPrefix) {
		t.Fatalf("checkpoint summary = %q", text)
	}
}

func TestRunStoredDoesNotResummarizeCheckpointAfterToolStep(t *testing.T) {
	provider := &toolStepCompactionProvider{}
	conversation := &advancingHistoryConversation{}
	tool := sdk.NewTool("echo", "echo", func(_ *sdk.ToolExecContext, _ struct{}) (any, error) {
		return "ok", nil
	})
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		tools: []sdk.Tool{tool},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 120, ReserveTokens: 20, KeepRecentTokens: 40,
		},
	}
	history := []sdk.Message{
		sdk.UserMessage(strings.Repeat("a", 240)),
		sdk.AssistantMessage(strings.Repeat("b", 240)),
		sdk.UserMessage("latest request"),
	}
	reply, err := loop.RunStored(t.Context(), history, conversation)
	if err != nil {
		t.Fatalf("RunStored() error = %v", err)
	}
	if reply != "done" || provider.calls.Load() != 3 || conversation.checkpointCount != 1 {
		t.Fatalf(
			"RunStored() = %q with %d calls and %d checkpoints, want done with 3 calls and 1 checkpoint",
			reply, provider.calls.Load(), conversation.checkpointCount,
		)
	}
}

type toolStepCompactionProvider struct {
	calls atomic.Int32
}

func (*toolStepCompactionProvider) Name() string { return "tool-step-compaction" }
func (*toolStepCompactionProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}
func (*toolStepCompactionProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*toolStepCompactionProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *toolStepCompactionProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		if params.System != summarySystemPrompt {
			return nil, errors.New("first request was not a summary request")
		}
		return &sdk.GenerateResult{
			Text:         "## Goal\nContinue the task",
			FinishReason: sdk.FinishReasonStop,
		}, nil
	case 2:
		if params.System == summarySystemPrompt {
			return nil, errors.New("model request was another summary")
		}
		return &sdk.GenerateResult{
			FinishReason: sdk.FinishReasonToolCalls,
			Usage:        sdk.Usage{TotalTokens: 500},
			ToolCalls: []sdk.ToolCall{{
				ToolCallID: "call-1", ToolName: "echo", Input: map[string]any{},
			}},
		}, nil
	case 3:
		if params.System == summarySystemPrompt {
			return nil, errors.New("tool step resummarized the checkpoint")
		}
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*toolStepCompactionProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type advancingHistoryConversation struct {
	compactionTestConversation
	seq atomic.Int64
}

func (c *advancingHistoryConversation) PrepareRequest(context.Context) (StoredInput, error) {
	return StoredInput{
		InputRevision: 1, HistoryThroughSeq: c.seq.Add(1), CheckpointRecordID: c.checkpointRecord,
	}, nil
}

func TestRunStoredRecoversOverflowOnce(t *testing.T) {
	provider := &overflowRecoveryProvider{}
	conversation := &compactionTestConversation{}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 10000, ReserveTokens: 100, KeepRecentTokens: 1,
		},
	}
	history := []sdk.Message{
		sdk.UserMessage(strings.Repeat("first ", 200)),
		sdk.AssistantMessage(strings.Repeat("second ", 200)),
		sdk.UserMessage(strings.Repeat("third ", 200)),
		sdk.UserMessage("latest"),
	}
	reply, err := loop.RunStored(t.Context(), history, conversation)
	if err != nil {
		t.Fatalf("RunStored() error = %v", err)
	}
	if reply != "done" || provider.calls.Load() != 3 {
		t.Fatalf("RunStored() = %q with %d calls, want done with 3 calls", reply, provider.calls.Load())
	}
	if conversation.checkpoint.Cause != "overflow" {
		t.Fatalf("overflow checkpoint = %#v", conversation.checkpoint)
	}
}

func TestRunStoredDoesNotCheckpointWhenSummaryOverflows(t *testing.T) {
	provider := &summaryOverflowProvider{}
	conversation := &compactionTestConversation{}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 10000, ReserveTokens: 100, KeepRecentTokens: 1,
		},
	}
	_, err := loop.RunStored(t.Context(), []sdk.Message{
		sdk.UserMessage(strings.Repeat("first ", 200)),
		sdk.AssistantMessage(strings.Repeat("second ", 200)),
		sdk.UserMessage("latest"),
	}, conversation)
	if err == nil || !errors.Is(err, ErrContextNotCompactable) {
		t.Fatalf("RunStored() error = %v, want context not compactable", err)
	}
	if provider.calls.Load() != 2 {
		t.Fatalf("provider calls = %d, want 2", provider.calls.Load())
	}
	if conversation.checkpoint.Cause != "" {
		t.Fatalf("unexpected checkpoint = %#v", conversation.checkpoint)
	}
}

func TestRunStoredStopsAfterOneOverflowRecovery(t *testing.T) {
	provider := &repeatedOverflowProvider{}
	conversation := &compactionTestConversation{}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 10000, ReserveTokens: 100, KeepRecentTokens: 1,
		},
	}
	_, err := loop.RunStored(t.Context(), []sdk.Message{
		sdk.UserMessage(strings.Repeat("first ", 200)),
		sdk.AssistantMessage(strings.Repeat("second ", 200)),
		sdk.UserMessage("latest"),
	}, conversation)
	if err == nil || !isContextOverflow(err) {
		t.Fatalf("RunStored() error = %v, want context overflow", err)
	}
	if provider.calls.Load() != 3 {
		t.Fatalf("provider calls = %d, want 3", provider.calls.Load())
	}
	if revision, ok := RequestFailureInputRevision(err); !ok || revision != 1 {
		t.Fatalf("request failure revision = %d, %t", revision, ok)
	}
}

func TestRunStoredUsesThresholdCheckpointAsOverflowParent(t *testing.T) {
	provider := &thresholdThenOverflowProvider{}
	conversation := &compactionTestConversation{}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 120, ReserveTokens: 20, KeepRecentTokens: 10,
		},
	}
	history := []sdk.Message{
		sdk.UserMessage(strings.Repeat("a", 240)),
		sdk.AssistantMessage(strings.Repeat("b", 240)),
		sdk.UserMessage("latest request"),
	}
	reply, err := loop.RunStored(t.Context(), history, conversation)
	if err != nil {
		t.Fatalf("RunStored() error = %v", err)
	}
	if reply != "done" || provider.calls.Load() != 4 {
		t.Fatalf("RunStored() = %q with %d calls, want done with 4 calls", reply, provider.calls.Load())
	}
	if conversation.checkpointCount != 2 || conversation.checkpoint.ParentRecordID != "checkpoint-1" ||
		conversation.checkpoint.Cause != "overflow" {
		t.Fatalf("final checkpoint = %#v, count %d", conversation.checkpoint, conversation.checkpointCount)
	}
}

type thresholdThenOverflowProvider struct {
	calls atomic.Int32
}

func (*thresholdThenOverflowProvider) Name() string { return "threshold-then-overflow" }
func (*thresholdThenOverflowProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}
func (*thresholdThenOverflowProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*thresholdThenOverflowProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *thresholdThenOverflowProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		return &sdk.GenerateResult{
			Text: "## Goal\n" + strings.Repeat("continue ", 6), FinishReason: sdk.FinishReasonStop,
		}, nil
	case 2:
		return nil, errors.New("400 context_length_exceeded")
	case 3:
		if params.System != summarySystemPrompt {
			return nil, errors.New("expected overflow summary request")
		}
		return &sdk.GenerateResult{Text: "## Goal\nContinue", FinishReason: sdk.FinishReasonStop}, nil
	case 4:
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*thresholdThenOverflowProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

func TestRunStoredRestartsCompactionWithNewInput(t *testing.T) {
	provider := &interruptibleCompactionProvider{started: make(chan struct{})}
	conversation := newInterruptibleCompactionConversation()
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		compaction: CompactionConfig{
			Enabled: true, ContextWindowTokens: 120, ReserveTokens: 20, KeepRecentTokens: 10,
		},
	}
	history := []sdk.Message{
		sdk.UserMessage(strings.Repeat("a", 240)),
		sdk.AssistantMessage(strings.Repeat("b", 240)),
		sdk.UserMessage("latest request"),
	}
	completed := make(chan error, 1)
	go func() {
		reply, err := loop.RunStored(t.Context(), history, conversation)
		if err == nil && reply != "done" {
			err = fmt.Errorf("reply = %q", reply)
		}
		completed <- err
	}()
	<-provider.started
	conversation.add(sdk.UserMessage("new input"))
	if err := <-completed; err != nil {
		t.Fatalf("RunStored() error = %v", err)
	}
	if provider.calls.Load() != 3 {
		t.Fatalf("provider calls = %d, want 3", provider.calls.Load())
	}
	if conversation.checkpoint.SourceInputRevision != 2 || conversation.checkpoint.SourceHistoryThroughSeq != 4 {
		t.Fatalf("checkpoint source = %#v", conversation.checkpoint)
	}
}

type interruptibleCompactionProvider struct {
	calls   atomic.Int32
	started chan struct{}
}

func (*interruptibleCompactionProvider) Name() string { return "interruptible-compaction" }
func (*interruptibleCompactionProvider) ListModels(context.Context) ([]sdk.Model, error) {
	return nil, nil
}
func (*interruptibleCompactionProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*interruptibleCompactionProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *interruptibleCompactionProvider) DoGenerate(
	ctx context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		close(p.started)
		<-ctx.Done()
		return nil, ctx.Err()
	case 2:
		if params.System != summarySystemPrompt {
			return nil, errors.New("expected restarted summary request")
		}
		return &sdk.GenerateResult{Text: "## Goal\nContinue", FinishReason: sdk.FinishReasonStop}, nil
	case 3:
		if got := userTexts(params.Messages); !equalStrings(got, []string{
			checkpointPrefix + "## Goal\nContinue", "latest request", "new input",
		}) {
			return nil, fmt.Errorf("normal request user messages = %#v", got)
		}
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*interruptibleCompactionProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type interruptibleCompactionConversation struct {
	mu         sync.Mutex
	revision   int64
	handled    int64
	historySeq int64
	pending    []sdk.Message
	changed    chan struct{}
	checkpoint StoredCheckpoint
}

func newInterruptibleCompactionConversation() *interruptibleCompactionConversation {
	return &interruptibleCompactionConversation{
		revision: 1, handled: 1, historySeq: 3, changed: make(chan struct{}),
	}
}

func (c *interruptibleCompactionConversation) add(message sdk.Message) {
	c.mu.Lock()
	c.revision++
	c.pending = append(c.pending, message)
	close(c.changed)
	c.changed = make(chan struct{})
	c.mu.Unlock()
}

func (c *interruptibleCompactionConversation) PrepareRequest(context.Context) (StoredInput, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	messages := append([]sdk.Message(nil), c.pending...)
	c.pending = nil
	c.historySeq += int64(len(messages))
	c.handled = c.revision
	return StoredInput{
		Messages: messages, InputRevision: c.revision, HistoryThroughSeq: c.historySeq,
	}, nil
}

func (c *interruptibleCompactionConversation) WatchInput(afterRevision int64) <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revision > afterRevision {
		ready := make(chan struct{})
		close(ready)
		return ready
	}
	return c.changed
}

func (c *interruptibleCompactionConversation) InputCurrent(
	_ context.Context,
	inputRevision int64,
) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.revision == inputRevision, nil
}

func (c *interruptibleCompactionConversation) AdmitResponse(
	_ context.Context,
	_ int64,
	inputRevision int64,
) (bool, error) {
	return c.InputCurrent(context.Background(), inputRevision)
}

func (c *interruptibleCompactionConversation) CommitCheckpoint(
	_ context.Context,
	checkpoint StoredCheckpoint,
) (StoredCheckpointResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if checkpoint.SourceInputRevision != c.revision || checkpoint.SourceHistoryThroughSeq != c.historySeq {
		return StoredCheckpointResult{}, nil
	}
	c.checkpoint = checkpoint
	return StoredCheckpointResult{RecordID: "checkpoint-2", Applied: true}, nil
}

func (c *interruptibleCompactionConversation) CommitStep(
	_ context.Context,
	_ *sdk.StepResult,
	final bool,
) (StoredStep, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return StoredStep{Sealed: final && c.revision == c.handled}, nil
}

type overflowRecoveryProvider struct {
	calls atomic.Int32
}

func (*overflowRecoveryProvider) Name() string                                    { return "overflow-recovery" }
func (*overflowRecoveryProvider) ListModels(context.Context) ([]sdk.Model, error) { return nil, nil }
func (*overflowRecoveryProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*overflowRecoveryProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *overflowRecoveryProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		return nil, errors.New("400 context_length_exceeded: maximum context length exceeded")
	case 2:
		if params.System != summarySystemPrompt {
			return nil, errors.New("expected summary request")
		}
		return &sdk.GenerateResult{Text: "## Goal\nContinue", FinishReason: sdk.FinishReasonStop}, nil
	case 3:
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*overflowRecoveryProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type summaryOverflowProvider struct {
	calls atomic.Int32
}

func (*summaryOverflowProvider) Name() string                                    { return "summary-overflow" }
func (*summaryOverflowProvider) ListModels(context.Context) ([]sdk.Model, error) { return nil, nil }
func (*summaryOverflowProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*summaryOverflowProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *summaryOverflowProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		return nil, errors.New("400 context_length_exceeded")
	case 2:
		if params.System != summarySystemPrompt {
			return nil, errors.New("expected summary request")
		}
		return nil, errors.New("400 context_length_exceeded: prompt is too long")
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*summaryOverflowProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type repeatedOverflowProvider struct {
	calls atomic.Int32
}

func (*repeatedOverflowProvider) Name() string                                    { return "repeated-overflow" }
func (*repeatedOverflowProvider) ListModels(context.Context) ([]sdk.Model, error) { return nil, nil }
func (*repeatedOverflowProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*repeatedOverflowProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *repeatedOverflowProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1, 3:
		return nil, errors.New("400 context_length_exceeded")
	case 2:
		if params.System != summarySystemPrompt {
			return nil, errors.New("expected summary request")
		}
		return &sdk.GenerateResult{Text: "## Goal\nContinue", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*repeatedOverflowProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type noticeProvider struct {
	active *bool
	fail   bool
	saw    bool
}

func (*noticeProvider) Name() string                                    { return "notice-test" }
func (*noticeProvider) ListModels(context.Context) ([]sdk.Model, error) { return nil, nil }
func (*noticeProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*noticeProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *noticeProvider) DoGenerate(context.Context, sdk.GenerateParams) (*sdk.GenerateResult, error) {
	p.saw = p.active != nil && *p.active
	if p.fail {
		return nil, errors.New("summary failed")
	}
	return &sdk.GenerateResult{
		Text:         "## Goal\nContinue the task\n## Next Steps\nAnswer the latest request",
		FinishReason: sdk.FinishReasonStop,
		Usage:        sdk.Usage{InputTokens: 70, OutputTokens: 15, TotalTokens: 85},
	}, nil
}
func (*noticeProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type compactionTestProvider struct {
	calls atomic.Int32
}

func (*compactionTestProvider) Name() string                                    { return "compaction-test" }
func (*compactionTestProvider) ListModels(context.Context) ([]sdk.Model, error) { return nil, nil }
func (*compactionTestProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*compactionTestProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *compactionTestProvider) DoGenerate(
	_ context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	switch call := p.calls.Add(1); call {
	case 1:
		if params.System != summarySystemPrompt || len(params.Tools) != 0 {
			return nil, errors.New("first request was not a tool-free summary request")
		}
		if params.MaxTokens == nil || *params.MaxTokens != 16 {
			return nil, fmt.Errorf("summary max tokens = %v, want 16", params.MaxTokens)
		}
		return &sdk.GenerateResult{
			Text:         "## Goal\nContinue the task\n## Next Steps\nAnswer the latest request",
			FinishReason: sdk.FinishReasonStop,
			Usage:        sdk.Usage{InputTokens: 70, OutputTokens: 15, TotalTokens: 85},
		}, nil
	case 2:
		if len(params.Messages) < 2 {
			return nil, fmt.Errorf("compacted messages = %d, want at least 2", len(params.Messages))
		}
		first, ok := params.Messages[0].Content[0].(sdk.TextPart)
		if !ok || !strings.HasPrefix(first.Text, checkpointPrefix) {
			return nil, errors.New("normal request did not use checkpoint context")
		}
		return &sdk.GenerateResult{Text: "done", FinishReason: sdk.FinishReasonStop}, nil
	default:
		return nil, fmt.Errorf("unexpected provider call %d", call)
	}
}
func (*compactionTestProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}

type compactionTestConversation struct {
	checkpoint       StoredCheckpoint
	checkpointRecord string
	checkpointCount  int
}

func (*compactionTestConversation) PrepareRequest(context.Context) (StoredInput, error) {
	return StoredInput{InputRevision: 1, HistoryThroughSeq: 3}, nil
}
func (*compactionTestConversation) WatchInput(int64) <-chan struct{} {
	return make(chan struct{})
}
func (*compactionTestConversation) InputCurrent(context.Context, int64) (bool, error) {
	return true, nil
}
func (*compactionTestConversation) AdmitResponse(context.Context, int64, int64) (bool, error) {
	return true, nil
}
func (c *compactionTestConversation) CommitCheckpoint(
	_ context.Context,
	checkpoint StoredCheckpoint,
) (StoredCheckpointResult, error) {
	if checkpoint.ParentRecordID != c.checkpointRecord {
		return StoredCheckpointResult{}, nil
	}
	c.checkpoint = checkpoint
	c.checkpointCount++
	c.checkpointRecord = fmt.Sprintf("checkpoint-%d", c.checkpointCount)
	return StoredCheckpointResult{RecordID: c.checkpointRecord, Applied: true}, nil
}
func (*compactionTestConversation) CommitStep(
	_ context.Context,
	_ *sdk.StepResult,
	final bool,
) (StoredStep, error) {
	return StoredStep{Sealed: final}, nil
}
