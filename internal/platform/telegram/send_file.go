package telegram

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/tools"
	"github.com/felinics/twilight/sdk"
	bot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

const (
	sendFileDescription  = `Send a file to the current Telegram chat. kind "photo" uploads an image as a compressed photo, up to 10MB. kind "document" uploads the original file unchanged, including original images, up to 50MB. caption is optional and at most 1024 characters.`
	photoMaxBytes        = 10 << 20
	documentMaxBytes     = 50 << 20
	sendFileCaptionRunes = 1024
)

type fileSender interface {
	SendPhoto(ctx context.Context, params *bot.SendPhotoParams) (*models.Message, error)
	SendDocument(ctx context.Context, params *bot.SendDocumentParams) (*models.Message, error)
}

type sendFileInput struct {
	Path    string `json:"path" jsonschema:"Path to the local file (relative or absolute)"`
	Kind    string `json:"kind" jsonschema:"photo sends a compressed image. document sends the original file"`
	Caption string `json:"caption,omitempty" jsonschema:"Optional caption, at most 1024 characters"`
}

type SendFiles struct {
	workspace string
	mu        sync.RWMutex
	sender    fileSender
	resume    func(chatID int64, threadID int)
}

func NewSendFiles(workspace string) (*SendFiles, error) {
	if strings.TrimSpace(workspace) == "" {
		return nil, errors.New("working directory is required")
	}
	absolute, err := filepath.Abs(workspace)
	if err != nil {
		return nil, fmt.Errorf("resolve working directory: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return nil, fmt.Errorf("stat working directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("working directory %q is not a directory", absolute)
	}
	return &SendFiles{workspace: absolute}, nil
}

func (s *SendFiles) Tool() sdk.Tool {
	return sdk.NewTool("send_file", sendFileDescription, func(ctx *sdk.ToolExecContext, input sendFileInput) (any, error) {
		return s.send(ctx, input)
	})
}

func (s *SendFiles) Bind(sender fileSender) {
	s.mu.Lock()
	s.sender = sender
	s.mu.Unlock()
}

func (s *SendFiles) ResumeTyping(resume func(chatID int64, threadID int)) {
	s.mu.Lock()
	s.resume = resume
	s.mu.Unlock()
}

func (s *Service) BindSendFiles(files *SendFiles) {
	if files == nil || s == nil || s.bot == nil {
		return
	}
	files.Bind(s.bot)
	files.ResumeTyping(s.continueTyping)
}

func (s *SendFiles) send(toolContext *sdk.ToolExecContext, input sendFileInput) (string, error) {
	if toolContext == nil || toolContext.Context == nil {
		return "", errors.New("send_file is only available in a Telegram conversation")
	}
	ctx := toolContext.Context
	if err := ctx.Err(); err != nil {
		return "", err
	}
	run, ok := agent.ToolRunFrom(ctx)
	if !ok || run.Platform != "telegram" || run.ChatID == "" {
		return "", errors.New("send_file is only available in a Telegram conversation")
	}
	kind := strings.ToLower(strings.TrimSpace(input.Kind))
	limit := int64(documentMaxBytes)
	switch kind {
	case "photo":
		limit = photoMaxBytes
	case "document":
	default:
		return "", fmt.Errorf("kind %q is invalid", input.Kind)
	}
	if utf8.RuneCountInString(input.Caption) > sendFileCaptionRunes {
		return "", errors.New("caption is longer than 1024 characters")
	}
	path, err := tools.ResolvePath(s.workspace, input.Path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat %s: %w", input.Path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a file", input.Path)
	}
	if info.Size() > limit {
		return "", fmt.Errorf("%s is larger than %dMB", kind, limit>>20)
	}
	chatID, err := strconv.ParseInt(run.ChatID, 10, 64)
	if err != nil {
		return "", fmt.Errorf("parse Telegram chat ID: %w", err)
	}
	threadID := 0
	if run.ThreadID != "" {
		threadID, err = strconv.Atoi(run.ThreadID)
		if err != nil {
			return "", fmt.Errorf("parse Telegram thread ID: %w", err)
		}
	}
	sender := s.currentSender()
	if sender == nil {
		return "", errors.New("telegram file sender is unavailable")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", input.Path, err)
	}
	defer func() { _ = file.Close() }()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	upload := &models.InputFileUpload{Filename: filepath.Base(path), Data: file}
	switch kind {
	case "photo":
		_, err = sender.SendPhoto(ctx, &bot.SendPhotoParams{
			ChatID: chatID, MessageThreadID: threadID, Photo: upload, Caption: input.Caption,
		})
	default:
		_, err = sender.SendDocument(ctx, &bot.SendDocumentParams{
			ChatID: chatID, MessageThreadID: threadID, Document: upload, Caption: input.Caption,
		})
	}
	if err != nil {
		return "", err
	}
	s.resumeTyping(chatID, threadID)
	return fmt.Sprintf("sent %s %s (%d bytes)", kind, filepath.Base(path), info.Size()), nil
}

func (s *SendFiles) resumeTyping(chatID int64, threadID int) {
	s.mu.RLock()
	resume := s.resume
	s.mu.RUnlock()
	if resume != nil {
		resume(chatID, threadID)
	}
}

func (s *SendFiles) currentSender() fileSender {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sender
}
