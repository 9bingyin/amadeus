package agent

import (
	"testing"

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
