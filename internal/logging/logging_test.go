package logging

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestNewJSONLoggerHonorsLevelAndSource(t *testing.T) {
	var output bytes.Buffer
	logger, err := New(Config{Level: "info", Format: "json", AddSource: true}, &output)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	logger.Debug("hidden", "value", "debug")
	logger.Info("visible", "value", "raw")

	var record map[string]any
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatalf("decode log: %v\noutput: %s", err, output.String())
	}
	if record["msg"] != "visible" || record["value"] != "raw" {
		t.Fatalf("record = %#v", record)
	}
	if _, ok := record["source"]; !ok {
		t.Fatalf("record has no source: %#v", record)
	}
	if strings.Contains(output.String(), "hidden") {
		t.Fatalf("debug record was emitted: %s", output.String())
	}
}

func TestNewTextLoggerEmitsDebug(t *testing.T) {
	var output bytes.Buffer
	logger, err := New(Config{Level: "debug", Format: "text"}, &output)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	logger.Debug("request", slog.String("prompt", "raw prompt"))
	if logOutput := output.String(); !strings.Contains(logOutput, "level=DEBUG") ||
		!strings.Contains(logOutput, `prompt="raw prompt"`) {
		t.Fatalf("output = %q", logOutput)
	}
}

func TestNewRejectsInvalidConfig(t *testing.T) {
	tests := []struct {
		name    string
		config  Config
		output  io.Writer
		wantErr string
	}{
		{name: "missing output", config: Config{Level: "info", Format: "text"}, wantErr: "log output is required"},
		{name: "invalid level", config: Config{Level: "trace", Format: "text"}, output: &bytes.Buffer{}, wantErr: `unsupported log level "trace"`},
		{name: "invalid format", config: Config{Level: "info", Format: "pretty"}, output: &bytes.Buffer{}, wantErr: `unsupported log format "pretty"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := New(test.config, test.output)
			if err == nil || err.Error() != test.wantErr {
				t.Fatalf("New() error = %v, want %q", err, test.wantErr)
			}
		})
	}
}
