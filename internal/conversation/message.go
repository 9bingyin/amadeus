package conversation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime"
	"strings"

	"github.com/felinics/twilight/sdk"
)

type BlobLoader func(context.Context, BlobDigest) ([]byte, error)

func EncodeStep(sequence int64, step *sdk.StepResult) ([]EncodedMessage, error) {
	if sequence < 0 {
		return nil, errors.New("step sequence must be non-negative")
	}
	if step == nil {
		return nil, errors.New("step is required")
	}
	encoded := make([]EncodedMessage, len(step.Messages))
	for index, message := range step.Messages {
		value, err := EncodeMessage(message)
		if err != nil {
			return nil, fmt.Errorf("encode step message %d: %w", index, err)
		}
		if message.Role == sdk.MessageRoleAssistant {
			value.Message.Step = &StepDTO{
				Sequence:        sequence,
				FinishReason:    string(step.FinishReason),
				RawFinishReason: step.RawFinishReason,
				Response: ResponseDTO{
					ID:        step.Response.ID,
					ModelID:   step.Response.ModelID,
					Timestamp: step.Response.Timestamp,
					Headers:   cloneStringMap(step.Response.Headers),
				},
			}
		}
		encoded[index] = value
	}
	return encoded, nil
}

func EncodeMessage(message sdk.Message) (EncodedMessage, error) {
	if !message.Role.Valid() {
		return EncodedMessage{}, fmt.Errorf("invalid message role %q", message.Role)
	}
	encoded := EncodedMessage{Message: MessageDTO{Role: string(message.Role)}}
	if message.Usage != nil {
		usage := usageFromSDK(*message.Usage)
		encoded.Message.Usage = &usage
	}
	encoded.Message.Parts = make([]PartDTO, 0, len(message.Content))
	for index, part := range message.Content {
		partDTO, blobs, err := encodePart(part)
		if err != nil {
			return EncodedMessage{}, fmt.Errorf("encode message part %d: %w", index, err)
		}
		encoded.Message.Parts = append(encoded.Message.Parts, partDTO)
		for _, blob := range blobs {
			encoded.Blobs = append(encoded.Blobs, EncodedBlob{PartIndex: index, Blob: blob})
		}
	}
	return encoded, nil
}

func (m MessageDTO) Decode(ctx context.Context, loadBlob BlobLoader) (sdk.Message, error) {
	role := sdk.MessageRole(m.Role)
	if !role.Valid() {
		return sdk.Message{}, fmt.Errorf("invalid message role %q", m.Role)
	}
	message := sdk.Message{Role: role, Content: make([]sdk.MessagePart, 0, len(m.Parts))}
	if m.Usage != nil {
		usage := m.Usage.sdk()
		message.Usage = &usage
	}
	for index, part := range m.Parts {
		decoded, err := part.decode(ctx, loadBlob)
		if err != nil {
			return sdk.Message{}, fmt.Errorf("decode message part %d: %w", index, err)
		}
		message.Content = append(message.Content, decoded)
	}
	return message, nil
}

func encodePart(part sdk.MessagePart) (PartDTO, []Blob, error) {
	switch value := part.(type) {
	case sdk.TextPart:
		metadata, err := encodeMetadata(value.ProviderMetadata)
		if err != nil {
			return PartDTO{}, nil, fmt.Errorf("encode text provider metadata: %w", err)
		}
		return PartDTO{Type: PartTypeText, Text: &TextPartDTO{
			Text:             value.Text,
			CacheControl:     cacheControlFromSDK(value.CacheControl),
			ProviderMetadata: metadata,
		}}, nil, nil
	case sdk.ReasoningPart:
		metadata, err := encodeMetadata(value.ProviderMetadata)
		if err != nil {
			return PartDTO{}, nil, fmt.Errorf("encode reasoning provider metadata: %w", err)
		}
		return PartDTO{Type: PartTypeReasoning, Reasoning: &ReasoningPartDTO{
			ID:               value.ID,
			Text:             value.Text,
			Format:           string(value.Format),
			Model:            value.Model,
			ProviderMetadata: metadata,
		}}, nil, nil
	case sdk.ImagePart:
		image, blob, err := encodeImage(value)
		if err != nil {
			return PartDTO{}, nil, err
		}
		var blobs []Blob
		if blob != nil {
			blobs = append(blobs, *blob)
		}
		return PartDTO{Type: PartTypeImage, Image: image}, blobs, nil
	case sdk.FilePart:
		data, err := base64.StdEncoding.DecodeString(value.Data)
		if err != nil {
			return PartDTO{}, nil, fmt.Errorf("decode file data: %w", err)
		}
		digest := DigestBlob(data)
		return PartDTO{Type: PartTypeFile, File: &FilePartDTO{
			Blob:         digest.String(),
			MediaType:    value.MediaType,
			Filename:     value.Filename,
			CacheControl: cacheControlFromSDK(value.CacheControl),
		}}, []Blob{{Digest: digest, Data: append([]byte(nil), data...)}}, nil
	case sdk.ToolCallPart:
		input, err := json.Marshal(value.Input)
		if err != nil {
			return PartDTO{}, nil, fmt.Errorf("encode tool input: %w", err)
		}
		metadata, err := encodeMetadata(value.ProviderMetadata)
		if err != nil {
			return PartDTO{}, nil, fmt.Errorf("encode tool provider metadata: %w", err)
		}
		return PartDTO{Type: PartTypeToolCall, ToolCall: &ToolCallPartDTO{
			ToolCallID:       value.ToolCallID,
			ToolName:         value.ToolName,
			Input:            input,
			CacheControl:     cacheControlFromSDK(value.CacheControl),
			ProviderMetadata: metadata,
		}}, nil, nil
	case sdk.ToolResultPart:
		result, err := json.Marshal(value.Result)
		if err != nil {
			return PartDTO{}, nil, fmt.Errorf("encode tool result: %w", err)
		}
		return PartDTO{Type: PartTypeToolResult, ToolResult: &ToolResultPartDTO{
			ToolCallID:   value.ToolCallID,
			ToolName:     value.ToolName,
			Result:       result,
			IsError:      value.IsError,
			CacheControl: cacheControlFromSDK(value.CacheControl),
		}}, nil, nil
	default:
		return PartDTO{}, nil, fmt.Errorf("unsupported message part %T", part)
	}
}

func (p PartDTO) decode(ctx context.Context, loadBlob BlobLoader) (sdk.MessagePart, error) {
	if err := p.validateVariant(); err != nil {
		return nil, err
	}
	switch p.Type {
	case PartTypeText:
		metadata, err := decodeMetadata(p.Text.ProviderMetadata)
		if err != nil {
			return nil, fmt.Errorf("decode text provider metadata: %w", err)
		}
		return sdk.TextPart{
			Text:             p.Text.Text,
			CacheControl:     p.Text.CacheControl.sdk(),
			ProviderMetadata: metadata,
		}, nil
	case PartTypeReasoning:
		metadata, err := decodeMetadata(p.Reasoning.ProviderMetadata)
		if err != nil {
			return nil, fmt.Errorf("decode reasoning provider metadata: %w", err)
		}
		return sdk.ReasoningPart{
			ID:               p.Reasoning.ID,
			Text:             p.Reasoning.Text,
			Format:           sdk.ReasoningFormat(p.Reasoning.Format),
			Model:            p.Reasoning.Model,
			ProviderMetadata: metadata,
		}, nil
	case PartTypeImage:
		image := p.Image.URL
		if p.Image.Blob != "" {
			data, err := loadBlobData(ctx, loadBlob, p.Image.Blob)
			if err != nil {
				return nil, err
			}
			mediaType := p.Image.MediaType
			if mediaType == "" {
				mediaType = "application/octet-stream"
			}
			image = "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data)
		}
		return sdk.ImagePart{
			Image:        image,
			MediaType:    p.Image.MediaType,
			CacheControl: p.Image.CacheControl.sdk(),
		}, nil
	case PartTypeFile:
		data, err := loadBlobData(ctx, loadBlob, p.File.Blob)
		if err != nil {
			return nil, err
		}
		return sdk.FilePart{
			Data:         base64.StdEncoding.EncodeToString(data),
			MediaType:    p.File.MediaType,
			Filename:     p.File.Filename,
			CacheControl: p.File.CacheControl.sdk(),
		}, nil
	case PartTypeToolCall:
		input, err := decodeJSON(p.ToolCall.Input)
		if err != nil {
			return nil, fmt.Errorf("decode tool input: %w", err)
		}
		metadata, err := decodeMetadata(p.ToolCall.ProviderMetadata)
		if err != nil {
			return nil, fmt.Errorf("decode tool provider metadata: %w", err)
		}
		return sdk.ToolCallPart{
			ToolCallID:       p.ToolCall.ToolCallID,
			ToolName:         p.ToolCall.ToolName,
			Input:            input,
			CacheControl:     p.ToolCall.CacheControl.sdk(),
			ProviderMetadata: metadata,
		}, nil
	case PartTypeToolResult:
		result, err := decodeJSON(p.ToolResult.Result)
		if err != nil {
			return nil, fmt.Errorf("decode tool result: %w", err)
		}
		return sdk.ToolResultPart{
			ToolCallID:   p.ToolResult.ToolCallID,
			ToolName:     p.ToolResult.ToolName,
			Result:       result,
			IsError:      p.ToolResult.IsError,
			CacheControl: p.ToolResult.CacheControl.sdk(),
		}, nil
	default:
		return nil, fmt.Errorf("unsupported part type %q", p.Type)
	}
}

func (p PartDTO) validateVariant() error {
	count := 0
	for _, present := range []bool{
		p.Text != nil,
		p.Reasoning != nil,
		p.Image != nil,
		p.File != nil,
		p.ToolCall != nil,
		p.ToolResult != nil,
	} {
		if present {
			count++
		}
	}
	if count != 1 {
		return fmt.Errorf("part type %q has %d payloads, want 1", p.Type, count)
	}
	valid := p.Type == PartTypeText && p.Text != nil ||
		p.Type == PartTypeReasoning && p.Reasoning != nil ||
		p.Type == PartTypeImage && p.Image != nil ||
		p.Type == PartTypeFile && p.File != nil ||
		p.Type == PartTypeToolCall && p.ToolCall != nil ||
		p.Type == PartTypeToolResult && p.ToolResult != nil
	if !valid {
		return fmt.Errorf("part type %q does not match its payload", p.Type)
	}
	if p.Type == PartTypeImage && (p.Image.Blob == "") == (p.Image.URL == "") {
		return errors.New("image part requires exactly one blob or URL")
	}
	if p.Type == PartTypeFile && p.File.Blob == "" {
		return errors.New("file part blob is required")
	}
	return nil
}

func encodeImage(value sdk.ImagePart) (*ImagePartDTO, *Blob, error) {
	image := &ImagePartDTO{MediaType: value.MediaType, CacheControl: cacheControlFromSDK(value.CacheControl)}
	if !strings.HasPrefix(value.Image, "data:") {
		if strings.TrimSpace(value.Image) == "" {
			return nil, nil, errors.New("image value is required")
		}
		image.URL = value.Image
		return image, nil, nil
	}
	comma := strings.IndexByte(value.Image, ',')
	if comma < 0 {
		return nil, nil, errors.New("image data URL has no payload")
	}
	metadata := value.Image[len("data:"):comma]
	if !strings.HasSuffix(metadata, ";base64") {
		return nil, nil, errors.New("image data URL is not base64 encoded")
	}
	mediaType := strings.TrimSuffix(metadata, ";base64")
	if mediaType != "" {
		parsed, _, err := mime.ParseMediaType(mediaType)
		if err != nil {
			return nil, nil, fmt.Errorf("parse image media type: %w", err)
		}
		mediaType = parsed
	}
	data, err := base64.StdEncoding.DecodeString(value.Image[comma+1:])
	if err != nil {
		return nil, nil, fmt.Errorf("decode image data: %w", err)
	}
	digest := DigestBlob(data)
	image.Blob = digest.String()
	if image.MediaType == "" {
		image.MediaType = mediaType
	}
	return image, &Blob{Digest: digest, Data: append([]byte(nil), data...)}, nil
}

func loadBlobData(ctx context.Context, load BlobLoader, digestText string) ([]byte, error) {
	if load == nil {
		return nil, errors.New("blob loader is required")
	}
	digest, err := ParseBlobDigest(digestText)
	if err != nil {
		return nil, err
	}
	data, err := load(ctx, digest)
	if err != nil {
		return nil, fmt.Errorf("load blob %s: %w", digest, err)
	}
	if DigestBlob(data) != digest {
		return nil, fmt.Errorf("blob %s digest does not match content", digest)
	}
	return data, nil
}

func encodeMetadata(metadata map[string]any) (json.RawMessage, error) {
	if len(metadata) == 0 {
		return nil, nil
	}
	return json.Marshal(metadata)
}

func decodeMetadata(data json.RawMessage) (map[string]any, error) {
	if len(data) == 0 {
		return nil, nil
	}
	value, err := decodeJSON(data)
	if err != nil {
		return nil, err
	}
	metadata, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("provider metadata is not an object")
	}
	return metadata, nil
}

func decodeJSON(data json.RawMessage) (any, error) {
	if !json.Valid(data) {
		return nil, errors.New("invalid JSON value")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("multiple JSON values")
	}
	return value, nil
}

func cacheControlFromSDK(value *sdk.CacheControl) *CacheControlDTO {
	if value == nil {
		return nil
	}
	return &CacheControlDTO{Type: value.Type, TTL: value.TTL}
}

func (c *CacheControlDTO) sdk() *sdk.CacheControl {
	if c == nil {
		return nil
	}
	return &sdk.CacheControl{Type: c.Type, TTL: c.TTL}
}

func usageFromSDK(value sdk.Usage) UsageDTO {
	return UsageDTO{
		InputTokens:           value.InputTokens,
		OutputTokens:          value.OutputTokens,
		TotalTokens:           value.TotalTokens,
		ReasoningTokens:       value.ReasoningTokens,
		CachedInputTokens:     value.CachedInputTokens,
		NoCacheTokens:         value.InputTokenDetails.NoCacheTokens,
		CacheReadTokens:       value.InputTokenDetails.CacheReadTokens,
		CacheWriteTokens:      value.InputTokenDetails.CacheWriteTokens,
		CacheWrite5mTokens:    value.InputTokenDetails.CacheWrite5mTokens,
		CacheWrite1hTokens:    value.InputTokenDetails.CacheWrite1hTokens,
		TextTokens:            value.OutputTokenDetails.TextTokens,
		OutputReasoningTokens: value.OutputTokenDetails.ReasoningTokens,
	}
}

func (u UsageDTO) sdk() sdk.Usage {
	return sdk.Usage{
		InputTokens:       u.InputTokens,
		OutputTokens:      u.OutputTokens,
		TotalTokens:       u.TotalTokens,
		ReasoningTokens:   u.ReasoningTokens,
		CachedInputTokens: u.CachedInputTokens,
		InputTokenDetails: sdk.InputTokenDetail{
			NoCacheTokens:      u.NoCacheTokens,
			CacheReadTokens:    u.CacheReadTokens,
			CacheWriteTokens:   u.CacheWriteTokens,
			CacheWrite5mTokens: u.CacheWrite5mTokens,
			CacheWrite1hTokens: u.CacheWrite1hTokens,
		},
		OutputTokenDetails: sdk.OutputTokenDetail{
			TextTokens:      u.TextTokens,
			ReasoningTokens: u.OutputReasoningTokens,
		},
	}
}

func cloneStringMap(value map[string]string) map[string]string {
	if value == nil {
		return nil
	}
	cloned := make(map[string]string, len(value))
	maps.Copy(cloned, value)
	return cloned
}
