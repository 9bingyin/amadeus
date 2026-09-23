package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/felinics/twilight/sdk"
)

func TestRewriteMemoryReturnsTheBulletList(t *testing.T) {
	provider := &dreamTestProvider{text: "- brief"}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		retry: RetryConfig{Enabled: false},
	}
	rewritten, err := loop.RewriteMemory(t.Context(), "user", "- long fact", 1400)
	if err != nil {
		t.Fatalf("RewriteMemory() error = %v", err)
	}
	if rewritten != "- brief" || provider.system != dreamSystemPrompt || provider.tools != 0 ||
		provider.maxTokens != dreamMaxTokens || !strings.Contains(provider.prompt, "who the user is") ||
		!strings.Contains(provider.prompt, "1400") || !strings.Contains(provider.prompt, "- long fact") {
		t.Fatalf("RewriteMemory() = %q, provider = %+v", rewritten, provider)
	}
}

func TestRewriteMemoryRejectsAnIncompleteResponse(t *testing.T) {
	provider := &dreamTestProvider{finish: sdk.FinishReasonLength, text: "- cut"}
	loop := &Loop{
		model: &sdk.Model{ID: "test-model", Provider: provider},
		retry: RetryConfig{Enabled: false},
	}
	if _, err := loop.RewriteMemory(t.Context(), "memory", "- fact", 2200); err == nil ||
		!strings.Contains(err.Error(), "incomplete") || !strings.Contains(provider.prompt, "This list is durable memory.") {
		t.Fatalf("RewriteMemory() error = %v, prompt = %q", err, provider.prompt)
	}
}

type dreamTestProvider struct {
	text      string
	finish    sdk.FinishReason
	system    string
	prompt    string
	tools     int
	maxTokens int
}

func (*dreamTestProvider) Name() string                                    { return "dream-test" }
func (*dreamTestProvider) ListModels(context.Context) ([]sdk.Model, error) { return nil, nil }
func (*dreamTestProvider) Test(context.Context) *sdk.ProviderTestResult {
	return &sdk.ProviderTestResult{Status: sdk.ProviderStatusOK}
}
func (*dreamTestProvider) TestModel(context.Context, string) (*sdk.ModelTestResult, error) {
	return &sdk.ModelTestResult{Supported: true}, nil
}
func (p *dreamTestProvider) DoGenerate(_ context.Context, params sdk.GenerateParams) (*sdk.GenerateResult, error) {
	p.system = params.System
	p.tools = len(params.Tools)
	if params.MaxTokens != nil {
		p.maxTokens = *params.MaxTokens
	}
	if len(params.Messages) == 1 {
		if part, ok := params.Messages[0].Content[0].(sdk.TextPart); ok {
			p.prompt = part.Text
		}
	}
	finish := p.finish
	if finish == "" {
		finish = sdk.FinishReasonStop
	}
	return &sdk.GenerateResult{Text: p.text, FinishReason: finish}, nil
}
func (*dreamTestProvider) DoStream(context.Context, sdk.GenerateParams) (*sdk.StreamResult, error) {
	return nil, errors.New("streaming is not supported")
}
