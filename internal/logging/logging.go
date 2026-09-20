package logging

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
)

type Config struct {
	Level     string
	Format    string
	AddSource bool
}

func New(config Config, output io.Writer) (*slog.Logger, error) {
	if output == nil {
		return nil, errors.New("log output is required")
	}

	var level slog.Level
	switch config.Level {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		return nil, fmt.Errorf("unsupported log level %q", config.Level)
	}

	options := &slog.HandlerOptions{Level: level, AddSource: config.AddSource}
	var handler slog.Handler
	switch config.Format {
	case "text":
		handler = slog.NewTextHandler(output, options)
	case "json":
		handler = slog.NewJSONHandler(output, options)
	default:
		return nil, fmt.Errorf("unsupported log format %q", config.Format)
	}
	return slog.New(handler), nil
}
