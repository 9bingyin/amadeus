package conversation

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/felinics/twilight/sdk"
)

func TestMessageRoundTrip(t *testing.T) {
	metadata := map[string]any{
		"openai": map[string]any{
			"itemId":                    "rs_1",
			"reasoningEncryptedContent": "encrypted",
		},
	}
	usage := sdk.Usage{
		InputTokens:       11,
		OutputTokens:      7,
		TotalTokens:       18,
		ReasoningTokens:   3,
		CachedInputTokens: 2,
		InputTokenDetails: sdk.InputTokenDetail{
			NoCacheTokens:      9,
			CacheReadTokens:    2,
			CacheWriteTokens:   4,
			CacheWrite5mTokens: 1,
			CacheWrite1hTokens: 3,
		},
		OutputTokenDetails: sdk.OutputTokenDetail{TextTokens: 4, ReasoningTokens: 3},
	}
	message := sdk.Message{
		Role:  sdk.MessageRoleAssistant,
		Usage: &usage,
		Content: []sdk.MessagePart{
			sdk.ReasoningPart{
				ID: "rs_1", Text: "summary", Format: sdk.ReasoningFormatOpenAIResponses, Model: "gpt-test",
				ProviderMetadata: metadata,
			},
			sdk.TextPart{
				Text: "answer", CacheControl: &sdk.CacheControl{Type: "ephemeral", TTL: "1h"},
				ProviderMetadata: map[string]any{"provider": map[string]any{"signature": "sig"}},
			},
			sdk.ToolCallPart{
				ToolCallID: "call_1", ToolName: "read", Input: map[string]any{"offset": 9007199254740993},
				ProviderMetadata: map[string]any{"opaque": "value"},
			},
		},
	}

	encoded, err := EncodeMessage(message)
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	serialized, err := json.Marshal(encoded.Message)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var restoredDTO MessageDTO
	if err := json.Unmarshal(serialized, &restoredDTO); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	restored, err := restoredDTO.Decode()
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if restored.Role != message.Role || !reflect.DeepEqual(*restored.Usage, usage) {
		t.Fatalf("restored message = %#v", restored)
	}
	reasoning, ok := restored.Content[0].(sdk.ReasoningPart)
	if !ok || reasoning.ID != "rs_1" || reasoning.Format != sdk.ReasoningFormatOpenAIResponses ||
		reasoning.ProviderMetadata["openai"].(map[string]any)["reasoningEncryptedContent"] != "encrypted" {
		t.Fatalf("reasoning = %#v", restored.Content[0])
	}
	toolCall, ok := restored.Content[2].(sdk.ToolCallPart)
	if !ok {
		t.Fatalf("tool call = %#v", restored.Content[2])
	}
	inputJSON, err := json.Marshal(toolCall.Input)
	if err != nil || string(inputJSON) != `{"offset":9007199254740993}` {
		t.Fatalf("tool input JSON = %s, error = %v", inputJSON, err)
	}
}

func TestEncodeMessageRejectsInlineBytes(t *testing.T) {
	_, err := EncodeMessage(sdk.Message{
		Role: sdk.MessageRoleUser,
		Content: []sdk.MessagePart{
			sdk.ImagePart{Image: "data:image/png;base64,aW1n", MediaType: "image/png"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "data URL") {
		t.Fatalf("EncodeMessage() image error = %v", err)
	}
	_, err = EncodeMessage(sdk.Message{
		Role: sdk.MessageRoleUser,
		Content: []sdk.MessagePart{
			sdk.FilePart{Data: "cGRm", MediaType: "application/pdf", Filename: "report.pdf"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "file URL") {
		t.Fatalf("EncodeMessage() file error = %v", err)
	}
}

func TestEncodeStepPreservesMetadata(t *testing.T) {
	timestamp := time.Date(2026, time.September, 20, 12, 0, 0, 0, time.UTC)
	step := &sdk.StepResult{
		FinishReason:    sdk.FinishReasonStop,
		RawFinishReason: "completed",
		Response: sdk.ResponseMetadata{
			ID: "resp_1", ModelID: "gpt-test", Timestamp: timestamp, Headers: map[string]string{"x-request-id": "req_1"},
		},
		Messages: []sdk.Message{sdk.AssistantMessage("done")},
	}
	encoded, err := EncodeStep(7, step)
	if err != nil {
		t.Fatalf("EncodeStep() error = %v", err)
	}
	metadata := encoded[0].Message.Step
	if metadata == nil || metadata.Sequence != 7 || metadata.FinishReason != "stop" || metadata.Response.ID != "resp_1" ||
		!metadata.Response.Timestamp.Equal(timestamp) {
		t.Fatalf("step metadata = %#v", metadata)
	}
}

func TestPartRejectsMismatchedPayload(t *testing.T) {
	_, err := (MessageDTO{Role: "user", Parts: []PartDTO{{
		Type: PartTypeText,
		File: &FilePartDTO{Path: "/tmp/file"},
	}}}).Decode()
	if err == nil || !strings.Contains(err.Error(), "part type") {
		t.Fatalf("Decode() error = %v", err)
	}
}

func TestFilePartPathRoundTrip(t *testing.T) {
	path := "/tmp/amadeus/attachments/100/190-def-report.pdf"
	encoded, err := EncodeMessage(sdk.Message{Role: sdk.MessageRoleUser, Content: []sdk.MessagePart{
		sdk.ImagePart{Image: encodeFileURL(path + ".jpg"), MediaType: "image/jpeg"},
		sdk.FilePart{Data: encodeFileURL(path), MediaType: "application/pdf", Filename: "report.pdf"},
	}})
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	if encoded.Message.Parts[0].Image == nil || encoded.Message.Parts[0].Image.URL != encodeFileURL(path+".jpg") {
		t.Fatalf("image part = %#v", encoded.Message.Parts[0])
	}
	if encoded.Message.Parts[1].File == nil || encoded.Message.Parts[1].File.Path != path {
		t.Fatalf("file part = %#v", encoded.Message.Parts[1])
	}
	restored, err := encoded.Message.Decode()
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	image, ok := restored.Content[0].(sdk.ImagePart)
	if !ok || image.Image != encodeFileURL(path+".jpg") {
		t.Fatalf("decoded image = %#v", restored.Content[0])
	}
	file, ok := restored.Content[1].(sdk.FilePart)
	if !ok || file.Data != encodeFileURL(path) {
		t.Fatalf("decoded file = %#v", restored.Content[1])
	}
}
