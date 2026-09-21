package agent

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/felinics/twilight/sdk"
)

func FileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}

func ParseFileURL(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "file" {
		return "", false
	}
	path := parsed.Path
	if path == "" {
		path = parsed.Opaque
	}
	path = filepath.FromSlash(path)
	if path == "" || !filepath.IsAbs(path) {
		return "", false
	}
	return filepath.Clean(path), true
}

func ResolveFileRefs(messages []sdk.Message) ([]sdk.Message, error) {
	resolved := make([]sdk.Message, len(messages))
	for index, message := range messages {
		resolved[index] = message
		if len(message.Content) == 0 {
			continue
		}
		resolved[index].Content = make([]sdk.MessagePart, len(message.Content))
		for partIndex, part := range message.Content {
			value, err := resolveFileRef(part)
			if err != nil {
				return nil, fmt.Errorf("message %d part %d: %w", index, partIndex, err)
			}
			resolved[index].Content[partIndex] = value
		}
	}
	return resolved, nil
}

func resolveFileRef(part sdk.MessagePart) (sdk.MessagePart, error) {
	switch value := part.(type) {
	case sdk.ImagePart:
		path, ok := ParseFileURL(value.Image)
		if !ok {
			return value, nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read image %q: %w", path, err)
		}
		mediaType := canonicalMediaType(value.MediaType)
		if mediaType == "" {
			mediaType = "application/octet-stream"
		}
		value.Image = "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data)
		value.MediaType = mediaType
		return value, nil
	case sdk.FilePart:
		path, ok := ParseFileURL(value.Data)
		if !ok {
			return value, nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read file %q: %w", path, err)
		}
		value.Data = base64.StdEncoding.EncodeToString(data)
		return value, nil
	default:
		return part, nil
	}
}
