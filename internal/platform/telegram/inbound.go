package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/gateway"
	tgbot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

const maxAttachmentBytes = 20 << 20

var errAttachmentTooLarge = errors.New("telegram attachment exceeds 20MB")

type inboundContent struct {
	Text        string
	Attachments []gateway.Attachment
}

func hasInboundContent(message *models.Message) bool {
	if strings.TrimSpace(message.Text) != "" || strings.TrimSpace(message.Caption) != "" {
		return true
	}
	return message.Animation != nil || message.Document != nil || len(message.Photo) > 0 ||
		message.Audio != nil || message.Sticker != nil || message.Video != nil ||
		message.VideoNote != nil || message.Voice != nil || message.Contact != nil ||
		message.Dice != nil || message.Poll != nil || message.Venue != nil ||
		message.Location != nil || message.RichMessage != nil
}

func (s *Service) inbound(ctx context.Context, message *models.Message) (inboundContent, error) {
	saved, attachments, err := s.saveInboundMedia(ctx, message)
	if err != nil {
		return inboundContent{}, err
	}
	text := formatInboundEnvelope(message, saved)
	if strings.TrimSpace(text) == "" && len(attachments) == 0 {
		return inboundContent{}, nil
	}
	return inboundContent{Text: text, Attachments: attachments}, nil
}

func (s *Service) saveInboundMedia(
	ctx context.Context,
	message *models.Message,
) (mediaLine string, attachments []gateway.Attachment, err error) {
	switch {
	case message.Animation != nil:
		if strings.TrimSpace(message.Caption) == "" {
			return "[animation]", nil, nil
		}
		return "[animation attachment unavailable]", nil, nil
	case message.Document != nil:
		return s.saveDocument(ctx, message)
	case len(message.Photo) > 0:
		return s.savePhoto(ctx, message)
	case message.Video != nil || message.VideoNote != nil:
		if strings.TrimSpace(message.Caption) == "" {
			return "[video]", nil, nil
		}
		return "[video attachment unavailable]", nil, nil
	case message.Audio != nil || message.Voice != nil:
		if strings.TrimSpace(message.Caption) == "" {
			return "[audio]", nil, nil
		}
		return "[audio attachment unavailable]", nil, nil
	case message.Sticker != nil:
		return formatSticker(message.Sticker), nil, nil
	default:
		return "", nil, nil
	}
}

func (s *Service) savePhoto(
	ctx context.Context,
	message *models.Message,
) (string, []gateway.Attachment, error) {
	photo := largestPhoto(message.Photo)
	filename := attachmentFileName(message.ID, photo.FileUniqueID, "photo.jpg")
	dest, saved, err := s.saveNamedFile(ctx, message.Chat.ID, filename, photo.FileID, int64(photo.FileSize))
	if err != nil {
		return "", nil, err
	}
	if !saved {
		return "[image attachment unavailable]", nil, nil
	}
	return s.nativeOrPathLine("image", dest, "image/jpeg", "photo.jpg")
}

func (s *Service) saveDocument(
	ctx context.Context,
	message *models.Message,
) (string, []gateway.Attachment, error) {
	document := message.Document
	original := strings.TrimSpace(document.FileName)
	filename := attachmentFileName(message.ID, document.FileUniqueID, original)
	dest, saved, err := s.saveNamedFile(ctx, message.Chat.ID, filename, document.FileID, document.FileSize)
	if err != nil {
		return "", nil, err
	}
	if !saved {
		return "[document attachment unavailable]", nil, nil
	}
	if original == "" {
		original = filepath.Base(dest)
	}
	mediaType := detectSavedMediaType(dest, document.MimeType, original)
	kind := "document"
	if strings.HasPrefix(mediaType, "image/") {
		kind = "image"
	}
	return s.nativeOrPathLine(kind, dest, mediaType, original)
}

func (s *Service) nativeOrPathLine(
	kind, dest, mediaType, filename string,
) (string, []gateway.Attachment, error) {
	line := "[" + kind + " " + dest + "]"
	attachmentKind, ok := agent.NativeAttachmentKind(mediaType)
	if !ok {
		return line, nil, nil
	}
	return line, []gateway.Attachment{{
		Kind: attachmentKind, Path: dest, MediaType: mediaType, Filename: filename,
	}}, nil
}

func (s *Service) saveNamedFile(
	ctx context.Context,
	chatID int64,
	filename, fileID string,
	declaredSize int64,
) (dest string, saved bool, err error) {
	if s.saveFile == nil || s.attachmentsDir == "" {
		return "", false, nil
	}
	if declaredSize > maxAttachmentBytes {
		slog.WarnContext(ctx, "Telegram attachment exceeds size limit", "file_id", fileID, "size", declaredSize)
		return "", false, nil
	}
	dest = filepath.Join(s.attachmentsDir, strconv.FormatInt(chatID, 10), filename)
	if err := s.saveFile(ctx, dest, fileID); err != nil {
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		if errors.Is(err, tgbot.ErrorUnauthorized) {
			return "", false, err
		}
		if errors.Is(err, errAttachmentTooLarge) {
			slog.WarnContext(ctx, "Telegram attachment exceeds size limit", "file_id", fileID)
			return "", false, nil
		}
		slog.ErrorContext(ctx, "Download Telegram attachment", "err", err, "file_id", fileID)
		return "", false, nil
	}
	return dest, true, nil
}

func (s *Service) saveTelegramFile(ctx context.Context, destPath, fileID string) (returnErr error) {
	if info, err := os.Stat(destPath); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
		return nil
	}
	file, err := s.bot.GetFile(ctx, &tgbot.GetFileParams{FileID: fileID})
	if err != nil {
		return fmt.Errorf("get Telegram file: %w", err)
	}
	if strings.TrimSpace(file.FilePath) == "" {
		return errors.New("telegram file path is empty")
	}
	if file.FileSize > maxAttachmentBytes {
		return errAttachmentTooLarge
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.bot.FileDownloadLink(file), http.NoBody)
	if err != nil {
		return errors.New("create Telegram file request")
	}
	response, err := s.fileHTTPClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("download Telegram file request failed")
	}
	defer func() {
		returnErr = errors.Join(returnErr, response.Body.Close())
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, response.Body)
		return fmt.Errorf("download Telegram file: HTTP status %d", response.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o700); err != nil {
		return fmt.Errorf("create attachment directory: %w", err)
	}
	partPath := destPath + ".part"
	output, err := os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create attachment file: %w", err)
	}
	written, copyErr := io.Copy(output, io.LimitReader(response.Body, maxAttachmentBytes+1))
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("write attachment file: %w", copyErr)
	}
	if syncErr != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("sync attachment file: %w", syncErr)
	}
	if closeErr != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("close attachment file: %w", closeErr)
	}
	if written > maxAttachmentBytes {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = os.Remove(partPath)
		return errAttachmentTooLarge
	}
	if err := os.Rename(partPath, destPath); err != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("commit attachment file: %w", err)
	}
	slog.DebugContext(ctx, "Saved Telegram file", "path", destPath, "file", file)
	return nil
}

func attachmentFileName(messageID int, uniqueID, original string) string {
	name := sanitizeFileName(original)
	if name == "" {
		name = "attachment"
	}
	unique := sanitizeFileName(uniqueID)
	if unique == "" {
		unique = "file"
	}
	return strconv.Itoa(messageID) + "-" + unique + "-" + name
}

func sanitizeFileName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	var builder strings.Builder
	builder.Grow(len(name))
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '-' || r == '_' {
			builder.WriteRune(r)
			continue
		}
		builder.WriteByte('_')
	}
	cleaned := strings.Trim(builder.String(), "._")
	if cleaned == "" {
		return ""
	}
	if len(cleaned) > 120 {
		ext := path.Ext(cleaned)
		base := strings.TrimSuffix(cleaned, ext)
		limit := 120 - len(ext)
		if limit < 1 {
			return cleaned[:120]
		}
		if len(base) > limit {
			base = base[:limit]
		}
		cleaned = base + ext
	}
	return cleaned
}

func detectSavedMediaType(dest, declared, filename string) string {
	mediaType := strings.TrimSpace(declared)
	if mediaType != "" && !strings.EqualFold(mediaType, "application/octet-stream") {
		return canonicalDeclaredMediaType(mediaType)
	}
	if extType := mime.TypeByExtension(path.Ext(filename)); extType != "" {
		return canonicalDeclaredMediaType(extType)
	}
	file, err := os.Open(dest)
	if err != nil {
		return "application/octet-stream"
	}
	defer file.Close()
	buf := make([]byte, 512)
	n, err := file.Read(buf)
	if err != nil && !errors.Is(err, io.EOF) {
		return "application/octet-stream"
	}
	detected := http.DetectContentType(buf[:n])
	if detected == "" {
		return "application/octet-stream"
	}
	return canonicalDeclaredMediaType(detected)
}

func canonicalDeclaredMediaType(value string) string {
	parsed, _, err := mime.ParseMediaType(value)
	if err != nil {
		return strings.ToLower(strings.TrimSpace(value))
	}
	return parsed
}
