package tool

import (
	"testing"

	"github.com/felinics/twilight/sdk"
)

func TestRichResultPreservesErrorAndImages(t *testing.T) {
	picture := sdk.ImagePart{Image: "file:///tmp/picture.png", MediaType: "image/png"}
	code := New("codemode", "Run script", func(*Context, struct{}) (any, error) {
		return Result{Text: "partial output", IsError: true, Images: []sdk.ImagePart{picture}}, nil
	})
	step, err := ExecuteStep(t.Context(), sdk.ModelResult{ToolCalls: []sdk.ToolCall{{ToolName: "codemode", ToolCallID: "code"}}}, []Tool{code})
	if err != nil {
		t.Fatal(err)
	}
	if len(step.Messages) != 3 || len(step.ToolResults) != 1 || !step.ToolResults[0].IsError || step.ToolResults[0].Result.String() != "partial output" {
		t.Fatalf("step = %#v", step)
	}
	message := step.Messages[2]
	if message.Role != sdk.MessageRoleUser || message.Content[1].(sdk.ImagePart) != picture {
		t.Fatalf("image message = %#v", message)
	}
}
