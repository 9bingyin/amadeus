package codemode

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/9bingyin/amadeus/internal/paths"
	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	quickjs "github.com/MichaelKinsy/PiG/codemode"
	"github.com/felinics/twilight/sdk"
)

func scriptValue(value any) (json.RawMessage, error) {
	if image, ok := value.(sdk.ImagePart); ok {
		var data []byte
		if strings.HasPrefix(image.Image, "data:") {
			_, encoded, found := strings.Cut(image.Image, ",")
			if !found {
				return nil, fmt.Errorf("invalid image data URL")
			}
			decoded, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return nil, fmt.Errorf("decode read image: %w", err)
			}
			data = decoded
		} else {
			location, err := url.Parse(image.Image)
			if err != nil || location.Scheme != "file" || location.Host != "" && location.Host != "localhost" {
				return nil, fmt.Errorf("read image is not a local file")
			}
			data, err = os.ReadFile(location.Path)
			if err != nil {
				return nil, fmt.Errorf("read tool image: %w", err)
			}
		}
		return json.Marshal(struct {
			Type     string `json:"type"`
			Data     string `json:"data"`
			MimeType string `json:"mimeType"`
		}{"image", base64.StdEncoding.EncodeToString(data), image.MediaType})
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode tool result for script: %w", err)
	}
	return encoded, nil
}

func formatResult(result quickjs.Result, elapsed time.Duration, maxTokens *int64) (toolkit.Result, error) {
	output := toolkit.Result{IsError: !result.OK}
	var text strings.Builder
	status := "completed"
	if !result.OK {
		status = "failed"
	}
	fmt.Fprintf(&text, "Script %s\nWall time: %.3f seconds\n", status, elapsed.Seconds())
	for _, item := range result.Output {
		text.WriteByte('\n')
		if item.Type != "image" {
			text.WriteString(item.Text)
			continue
		}
		data, err := base64.StdEncoding.DecodeString(item.Data)
		if err != nil {
			return toolkit.Result{}, fmt.Errorf("decode script output image: %w", err)
		}
		extension := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[item.MimeType]
		if extension == "" {
			return toolkit.Result{}, fmt.Errorf("unsupported script image type %q", item.MimeType)
		}
		path, err := saveOutput("codemode-image-*"+extension, data)
		if err != nil {
			return toolkit.Result{}, err
		}
		fmt.Fprintf(&text, "Image saved to: %s", path)
		output.Images = append(output.Images, sdk.ImagePart{
			Image: (&url.URL{Scheme: "file", Path: path}).String(), MediaType: item.MimeType,
		})
	}
	if len(result.Value) > 0 {
		text.WriteByte('\n')
		var value string
		if err := json.Unmarshal(result.Value, &value); result.Value[0] == '"' && err == nil {
			text.WriteString(value)
		} else {
			text.Write(result.Value)
		}
	}
	if !result.OK {
		text.WriteString("\n\nScript error:\n")
		text.WriteString(scriptError(result.Error))
		if len(result.Calls) > 0 {
			text.WriteString("\n\nTool calls made before the failure (they are not undone):")
			for _, call := range result.Calls {
				fmt.Fprintf(&text, "\n- %s (%s)", call.Name, call.Status)
			}
		}
	}
	budget := int64(10000)
	if maxTokens != nil {
		budget = *maxTokens
	}
	full := text.String()
	if int64(utf8.RuneCountInString(full)) <= budget*4 {
		output.Text = full
		return output, nil
	}
	path, err := saveOutput("codemode-*.log", []byte(full))
	if err != nil {
		return toolkit.Result{}, err
	}
	characters := []rune(full)
	keep := int(budget * 4)
	head, tail := (keep+1)/2, keep/2
	output.Text = string(characters[:head]) + "\n[output truncated]\n" + string(characters[len(characters)-tail:]) + "\n\nFull output: " + path
	return output, nil
}

func saveOutput(pattern string, data []byte) (string, error) {
	directory, err := paths.ToolOutputsDirectory()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("create codemode output directory: %w", err)
	}
	file, err := os.CreateTemp(directory, pattern)
	if err != nil {
		return "", fmt.Errorf("create codemode output file: %w", err)
	}
	path := file.Name()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("write codemode output: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("close codemode output: %w", err)
	}
	return path, nil
}
