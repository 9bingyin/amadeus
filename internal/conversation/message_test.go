package conversation

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"

	"github.com/felinics/twilight/sdk"
)

func TestMessageRoundTrip(t *testing.T) {
	metadata := sdk.ProviderMetadata{
		"openai": {
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
				ProviderMetadata: sdk.ProviderMetadata{"provider": {"signature": "sig"}},
			},
			sdk.ToolCallPart{
				ToolCallID: "call_1", ToolName: "read", Input: toolArguments(map[string]any{"offset": 9007199254740993}),
				ProviderMetadata: sdk.ProviderMetadata{"provider": {"opaque": "value"}},
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
		reasoning.ProviderMetadata.Get("openai", "reasoningEncryptedContent") != "encrypted" {
		t.Fatalf("reasoning = %#v", restored.Content[0])
	}
	toolCall, ok := restored.Content[2].(sdk.ToolCallPart)
	if !ok {
		t.Fatalf("tool call = %#v", restored.Content[2])
	}
	inputJSON, err := json.Marshal(json.RawMessage(toolCall.Input.Object()))
	if err != nil || string(inputJSON) != `{"offset":9007199254740992}` {
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
	step := &toolkit.Step{
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

func TestInvalidToolArgumentsRoundTrip(t *testing.T) {
	arguments := sdk.ParseToolArguments(`{"text":`)
	encoded, err := EncodeMessage(sdk.Message{Role: sdk.MessageRoleAssistant, Content: []sdk.MessagePart{
		sdk.ToolCallPart{ToolCallID: "call", ToolName: "echo", Input: arguments},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded.Message.Parts[0].ToolCall.Input) != `{}` {
		t.Fatalf("stored input = %s", encoded.Message.Parts[0].ToolCall.Input)
	}
	restored, err := encoded.Message.Decode()
	if err != nil {
		t.Fatal(err)
	}
	call := restored.Content[0].(sdk.ToolCallPart)
	if call.Input.Valid() || call.Input.Text != arguments.Text {
		t.Fatalf("restored arguments = %#v", call.Input)
	}
}

func TestToolOutputRoundTrip(t *testing.T) {
	for _, output := range []sdk.ToolOutput{
		sdk.TextOutput("result"),
		{JSON: json.RawMessage(`{"value":1}`)},
		{JSON: json.RawMessage(`"json string"`)},
	} {
		encoded, err := EncodeMessage(sdk.ToolMessage(sdk.ToolResultPart{ToolCallID: "call", ToolName: "echo", Result: output}))
		if err != nil {
			t.Fatal(err)
		}
		restored, err := encoded.Message.Decode()
		if err != nil {
			t.Fatal(err)
		}
		if result := restored.Content[0].(sdk.ToolResultPart).Result; !reflect.DeepEqual(result, output) {
			t.Fatalf("restored output = %#v, want %#v", result, output)
		}
	}
}

func TestDecodeLegacyToolMessage(t *testing.T) {
	var message MessageDTO
	if err := json.Unmarshal([]byte(`{"role":"tool","parts":[{"type":"tool_result","toolResult":{"toolCallId":"call","toolName":"read","result":{"image":"file:///tmp/image.jpg","mediaType":"image/jpeg"}}}]}`), &message); err != nil {
		t.Fatal(err)
	}
	restored, err := message.Decode()
	if err != nil {
		t.Fatal(err)
	}
	result := restored.Content[0].(sdk.ToolResultPart).Result
	if !result.IsJSON() || result.String() != `{"image":"file:///tmp/image.jpg","mediaType":"image/jpeg"}` {
		t.Fatalf("legacy output = %#v", result)
	}
}

func TestDecodeLegacyProviderMetadata(t *testing.T) {
	metadata, err := decodeMetadata(json.RawMessage(`{"openai":{"itemId":"reasoning-1","reasoningEncryptedContent":"encrypted","summary":[{"text":"thought"}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Get("openai", "reasoningEncryptedContent") != "encrypted" || metadata.Get("openai", "summary") != `[{"text":"thought"}]` {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func toolArguments(value any) sdk.ToolArguments {
	arguments, err := sdk.ToolArgumentsJSON(value)
	if err != nil {
		panic(err)
	}
	return arguments
}
