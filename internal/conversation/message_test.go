package conversation

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
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
	restored, err := restoredDTO.Decode(t.Context(), nil)
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

func TestMessageRoundTripBlobs(t *testing.T) {
	imageData := []byte("image bytes")
	fileData := []byte("file bytes")
	message := sdk.Message{
		Role: sdk.MessageRoleUser,
		Content: []sdk.MessagePart{
			sdk.ImagePart{
				Image:     "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageData),
				MediaType: "image/png",
			},
			sdk.FilePart{
				Data:      base64.StdEncoding.EncodeToString(fileData),
				MediaType: "application/pdf",
				Filename:  "report.pdf",
			},
		},
	}
	encoded, err := EncodeMessage(message)
	if err != nil {
		t.Fatalf("EncodeMessage() error = %v", err)
	}
	if len(encoded.Blobs) != 2 || encoded.Message.Parts[0].Image.Blob == "" || encoded.Message.Parts[1].File.Blob == "" {
		t.Fatalf("encoded = %#v", encoded)
	}
	blobs := make(map[BlobDigest][]byte, len(encoded.Blobs))
	for _, encodedBlob := range encoded.Blobs {
		blobs[encodedBlob.Blob.Digest] = encodedBlob.Blob.Data
	}
	load := func(_ context.Context, digest BlobDigest) ([]byte, error) {
		data, ok := blobs[digest]
		if !ok {
			return nil, errors.New("not found")
		}
		return data, nil
	}
	restored, err := encoded.Message.Decode(t.Context(), load)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	image := restored.Content[0].(sdk.ImagePart)
	file := restored.Content[1].(sdk.FilePart)
	if image.Image != message.Content[0].(sdk.ImagePart).Image || file.Data != message.Content[1].(sdk.FilePart).Data {
		t.Fatalf("restored = %#v", restored)
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
		File: &FilePartDTO{Blob: DigestBlob([]byte("file")).String()},
	}}}).Decode(t.Context(), nil)
	if err == nil {
		t.Fatal("Decode() error = nil")
	}
}
