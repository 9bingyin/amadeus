package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/gateway"
	tgmd "github.com/eekstunt/telegramify-markdown-go"
	tgbot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

func TestNewValidatesConfig(t *testing.T) {
	tests := []struct {
		name    string
		config  Config
		respond gateway.Handler
		wantErr string
	}{
		{
			name:    "missing token",
			config:  Config{AllowedUserIDs: []int64{1}},
			respond: successfulResponder,
			wantErr: "bot token is required",
		},
		{
			name:    "missing responder",
			config:  Config{BotToken: "123:token", AllowedUserIDs: []int64{1}},
			wantErr: "message handler is required",
		},
		{
			name:    "missing allowlist",
			config:  Config{BotToken: "123:token"},
			respond: successfulResponder,
			wantErr: "allowed user ID is required",
		},
		{
			name:    "invalid user ID",
			config:  Config{BotToken: "123:token", AllowedUserIDs: []int64{0}},
			respond: successfulResponder,
			wantErr: "invalid Telegram allowed user ID 0",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := newService(test.config, test.respond, tgbot.WithSkipGetMe())
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("newService() error = %v, want containing %q", err, test.wantErr)
			}
		})
	}
}

func TestNewRejectsMalformedTokenWithoutLeakingIt(t *testing.T) {
	const token = "123:SECRET\nSUFFIX"
	_, err := newService(Config{
		BotToken:       token,
		AllowedUserIDs: []int64{42},
	}, successfulResponder, tgbot.WithSkipGetMe())
	if err == nil || !strings.Contains(err.Error(), "invalid format") {
		t.Fatalf("newService() error = %v", err)
	}
	if strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("newService() leaked token in error: %v", err)
	}
}

func TestNew(t *testing.T) {
	service, err := newService(Config{
		BotToken:       "123:token",
		AllowedUserIDs: []int64{42, 42},
	}, successfulResponder, tgbot.WithSkipGetMe())
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	if service.bot == nil {
		t.Fatal("newService() returned nil bot")
	}
	if len(service.allowedUserIDs) != 1 {
		t.Fatalf("allowlist length = %d, want 1", len(service.allowedUserIDs))
	}
}

func TestRunStopsWithContext(t *testing.T) {
	pollingStarted := make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bot123:token/getMe":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"result": map[string]any{"id": 123, "is_bot": true, "first_name": "bot"},
			}); err != nil {
				t.Errorf("encode getMe response: %v", err)
			}
		case "/bot123:token/deleteWebhook":
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
				t.Errorf("encode deleteWebhook response: %v", err)
			}
		case "/bot123:token/getUpdates":
			once.Do(func() { close(pollingStarted) })
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": []any{}}); err != nil {
				t.Errorf("encode getUpdates response: %v", err)
			}
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)

	service, err := newService(Config{
		BotToken:       "123:token",
		AllowedUserIDs: []int64{42},
	}, successfulResponder, tgbot.WithSkipGetMe(), tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- service.Run(ctx) }()

	select {
	case <-pollingStarted:
		cancel()
	case <-time.After(5 * time.Second):
		t.Fatal("Telegram polling did not start")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not stop")
	}
}

func TestRunWaitsForActiveMessageHandlerOnCancellation(t *testing.T) {
	var updates atomic.Int32
	server := newPollingTestServer(t, func(w http.ResponseWriter, request *http.Request) {
		if updates.Add(1) == 1 {
			response := map[string]any{
				"ok": true,
				"result": []any{map[string]any{
					"update_id": 1,
					"message": map[string]any{
						"message_id": 1,
						"date":       1,
						"text":       "hello",
						"from": map[string]any{
							"id": 42, "is_bot": false, "first_name": "user",
						},
						"chat": map[string]any{"id": 42, "type": "private"},
					},
				}},
			}
			if err := json.NewEncoder(w).Encode(response); err != nil {
				t.Errorf("encode update: %v", err)
			}
			return
		}
		if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": []any{}}); err != nil {
			t.Errorf("encode empty updates: %v", err)
		}
	})
	started := make(chan struct{})
	finished := make(chan struct{})
	service, err := newService(Config{
		BotToken: "123:token", AllowedUserIDs: []int64{42},
	}, gateway.HandlerFunc(func(ctx context.Context, _ gateway.Message) (string, error) {
		close(started)
		<-ctx.Done()
		close(finished)
		return "", ctx.Err()
	}), tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- service.Run(ctx) }()
	select {
	case <-started:
		cancel()
	case <-time.After(5 * time.Second):
		t.Fatal("message handler did not start")
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("message handler did not receive cancellation")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not wait for message handler")
	}
}

func TestRunTreatsStartupCancellationAsCleanShutdown(t *testing.T) {
	for _, stage := range []string{"getMe", "deleteWebhook"} {
		t.Run(stage, func(t *testing.T) {
			started := make(chan struct{})
			var once sync.Once
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/bot123:token/getMe":
					if stage == "getMe" {
						once.Do(func() { close(started) })
						<-request.Context().Done()
						return
					}
					if err := json.NewEncoder(w).Encode(map[string]any{
						"ok": true, "result": map[string]any{"id": 123, "is_bot": true, "first_name": "bot"},
					}); err != nil {
						t.Errorf("encode getMe response: %v", err)
					}
				case "/bot123:token/deleteWebhook":
					once.Do(func() { close(started) })
					<-request.Context().Done()
				default:
					http.NotFound(w, request)
				}
			}))
			t.Cleanup(server.Close)
			service, err := newService(Config{
				BotToken: "123:token", AllowedUserIDs: []int64{42},
			}, successfulResponder, tgbot.WithServerURL(server.URL))
			if err != nil {
				t.Fatalf("newService() error = %v", err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() { done <- service.Run(ctx) }()
			<-started
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("Run() error = %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("Run() did not stop after startup cancellation")
			}
		})
	}
}

func TestRunStopsOnPermanentPollingError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bot123:token/getMe":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"result": map[string]any{"id": 123, "is_bot": true, "first_name": "bot"},
			}); err != nil {
				t.Errorf("encode getMe response: %v", err)
			}
		case "/bot123:token/deleteWebhook":
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
				t.Errorf("encode deleteWebhook response: %v", err)
			}
		case "/bot123:token/getUpdates":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"ok": false, "error_code": http.StatusConflict, "description": "Conflict",
			}); err != nil {
				t.Errorf("encode getUpdates response: %v", err)
			}
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)

	service, err := newService(Config{
		BotToken:       "123:token",
		AllowedUserIDs: []int64{42},
	}, successfulResponder, tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- service.Run(t.Context()) }()
	select {
	case err := <-done:
		if err == nil || !errors.Is(err, tgbot.ErrorConflict) {
			t.Fatalf("Run() error = %v, want conflict", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not stop after permanent polling error")
	}
}

func TestRunPreservesDeadlineError(t *testing.T) {
	server := newPollingTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": []any{}}); err != nil {
			t.Errorf("encode getUpdates response: %v", err)
		}
	})
	service, err := newService(Config{
		BotToken:       "123:token",
		AllowedUserIDs: []int64{42},
	}, successfulResponder, tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()

	err = service.Run(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run() error = %v, want deadline exceeded", err)
	}
}

func TestUnauthorizedSendStopsLaterUpdates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bot123:token/sendChatAction":
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
				t.Errorf("encode sendChatAction response: %v", err)
			}
		case "/bot123:token/sendMessage":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"ok": false, "error_code": http.StatusUnauthorized, "description": "Unauthorized",
			}); err != nil {
				t.Errorf("encode sendMessage response: %v", err)
			}
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)

	responses := 0
	service, err := newService(Config{
		BotToken:       "123:token",
		AllowedUserIDs: []int64{42},
	}, responder(func(context.Context, string) (string, error) {
		responses++
		return "reply", nil
	}), tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	update := &models.Update{Message: privateMessage(42, "hello")}
	service.bot.ProcessUpdate(t.Context(), update)
	service.bot.ProcessUpdate(t.Context(), update)

	if responses != 1 {
		t.Fatalf("responses = %d, want 1", responses)
	}
	if !service.fatal.Load() {
		t.Fatal("service did not record fatal authorization error")
	}
	select {
	case err := <-service.fatalErrors:
		if !errors.Is(err, tgbot.ErrorUnauthorized) {
			t.Fatalf("fatal error = %v, want unauthorized", err)
		}
	default:
		t.Fatal("service did not publish fatal authorization error")
	}
}

func TestUnauthorizedAttachmentDownloadStopsLaterUpdates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/bot123:token/sendChatAction" {
			http.NotFound(w, request)
			return
		}
		if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
			t.Errorf("encode sendChatAction response: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	responses := 0
	service, err := newService(Config{
		BotToken: "123:token", AllowedUserIDs: []int64{42},
	}, responder(func(context.Context, string) (string, error) {
		responses++
		return "reply", nil
	}), tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	service.downloadFile = func(context.Context, string) ([]byte, string, error) {
		return nil, "", fmt.Errorf("get file: %w", tgbot.ErrorUnauthorized)
	}
	photoMessage := privateMessage(42, "")
	photoMessage.Photo = []models.PhotoSize{{FileID: "photo"}}

	service.handleUpdate(t.Context(), service.bot, &models.Update{Message: photoMessage})
	service.handleUpdate(t.Context(), service.bot, &models.Update{Message: privateMessage(42, "hello")})

	if responses != 0 {
		t.Fatalf("responses = %d, want 0", responses)
	}
	if !service.fatal.Load() {
		t.Fatal("service did not record fatal authorization error")
	}
	select {
	case err := <-service.fatalErrors:
		if !errors.Is(err, tgbot.ErrorUnauthorized) {
			t.Fatalf("fatal error = %v, want unauthorized", err)
		}
	default:
		t.Fatal("service did not publish fatal authorization error")
	}
}

func TestHandleMessage(t *testing.T) {
	tests := []struct {
		name           string
		message        *models.Message
		allowedUserIDs []int64
		wantResponses  int
		wantMessages   int
		wantActions    int
	}{
		{
			name:           "allowed private text",
			message:        privateMessage(42, "hello"),
			allowedUserIDs: []int64{42},
			wantResponses:  1,
			wantMessages:   1,
			wantActions:    1,
		},
		{
			name:           "unauthorized user",
			message:        privateMessage(7, "hello"),
			allowedUserIDs: []int64{42},
		},
		{
			name:           "group message",
			message:        message(42, models.ChatTypeGroup, "hello"),
			allowedUserIDs: []int64{42},
		},
		{
			name: "bot message",
			message: func() *models.Message {
				message := privateMessage(42, "hello")
				message.From.IsBot = true
				return message
			}(),
			allowedUserIDs: []int64{42},
		},
		{
			name:           "empty text",
			message:        privateMessage(42, "  "),
			allowedUserIDs: []int64{42},
		},
		{
			name:           "missing sender",
			message:        &models.Message{Chat: models.Chat{Type: models.ChatTypePrivate}},
			allowedUserIDs: []int64{42},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			responses := 0
			sender := &fakeSender{}
			service := testService(test.allowedUserIDs, func(_ context.Context, prompt string) (string, error) {
				responses++
				if prompt != "hello" {
					t.Fatalf("prompt = %q, want %q", prompt, "hello")
				}
				return "world", nil
			})

			if err := service.handleMessage(t.Context(), sender, test.message); err != nil {
				t.Fatalf("handleMessage() error = %v", err)
			}
			if responses != test.wantResponses {
				t.Fatalf("responses = %d, want %d", responses, test.wantResponses)
			}
			if len(sender.messages) != test.wantMessages {
				t.Fatalf("sent messages = %d, want %d", len(sender.messages), test.wantMessages)
			}
			if len(sender.actions) != test.wantActions {
				t.Fatalf("chat actions = %d, want %d", len(sender.actions), test.wantActions)
			}
		})
	}
}

func TestHandleMessageForwardsGatewayMessage(t *testing.T) {
	var received gateway.Message
	service := &Service{
		handler: gateway.HandlerFunc(func(_ context.Context, message gateway.Message) (string, error) {
			received = message
			return "reply", nil
		}),
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	sender := &fakeSender{}
	message := privateMessage(42, " hello ")
	message.Chat.ID = 100

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	want := gateway.Message{
		Platform:       "telegram",
		ConversationID: "100",
		SenderID:       "42",
		Text:           "hello",
	}
	if !reflect.DeepEqual(received, want) {
		t.Fatalf("message = %#v, want %#v", received, want)
	}
}

func TestAttachments(t *testing.T) {
	tests := []struct {
		name          string
		message       *models.Message
		wantFileID    string
		downloadData  []byte
		wantKind      gateway.AttachmentKind
		wantMediaType string
		wantFilename  string
	}{
		{
			name: "largest photo",
			message: &models.Message{Photo: []models.PhotoSize{
				{FileID: "small", Width: 100, Height: 100, FileSize: 100},
				{FileID: "large", Width: 1000, Height: 1000, FileSize: 1000},
			}},
			wantFileID: "large", wantKind: gateway.AttachmentKindImage,
			wantMediaType: "image/jpeg", wantFilename: "photo.jpg",
		},
		{
			name: "image document",
			message: &models.Message{Document: &models.Document{
				FileID: "image", FileName: "diagram.png", MimeType: "image/png",
			}},
			wantFileID: "image", wantKind: gateway.AttachmentKindImage,
			wantMediaType: "image/png", wantFilename: "diagram.png",
		},
		{
			name: "generic MIME image document",
			message: &models.Message{Document: &models.Document{
				FileID: "generic-image", FileName: "diagram.png", MimeType: "application/octet-stream",
			}},
			wantFileID: "generic-image", downloadData: []byte("\x89PNG\r\n\x1a\nimage"),
			wantKind: gateway.AttachmentKindImage, wantMediaType: "image/png", wantFilename: "diagram.png",
		},
		{
			name: "extension prevents false image detection",
			message: &models.Message{Document: &models.Document{
				FileID: "csv", FileName: "metrics.csv", MimeType: "application/octet-stream",
			}},
			wantFileID: "csv", downloadData: []byte("BMI,age\n22,30\n"),
			wantKind: gateway.AttachmentKindFile, wantMediaType: mime.TypeByExtension(".csv"), wantFilename: "metrics.csv",
		},
		{
			name: "PDF document",
			message: &models.Message{Document: &models.Document{
				FileID: "pdf", FileName: "report.pdf", MimeType: "application/pdf",
			}},
			wantFileID: "pdf", wantKind: gateway.AttachmentKindFile,
			wantMediaType: "application/pdf", wantFilename: "report.pdf",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var downloadedFileID string
			service := &Service{downloadFile: func(_ context.Context, fileID string) ([]byte, string, error) {
				downloadedFileID = fileID
				if test.downloadData != nil {
					return test.downloadData, "files/fallback.bin", nil
				}
				return []byte(fileID), "files/fallback.bin", nil
			}}
			attachments, err := service.attachments(t.Context(), test.message)
			if err != nil {
				t.Fatalf("attachments() error = %v", err)
			}
			if len(attachments) != 1 {
				t.Fatalf("attachments = %#v", attachments)
			}
			attachment := attachments[0]
			if downloadedFileID != test.wantFileID || attachment.Kind != test.wantKind ||
				attachment.MediaType != test.wantMediaType || attachment.Filename != test.wantFilename {
				t.Fatalf("attachment = %#v", attachment)
			}
		})
	}
}

func TestHandleMessageForwardsCaptionAndDocument(t *testing.T) {
	var received gateway.Message
	service := &Service{
		handler: gateway.HandlerFunc(func(_ context.Context, message gateway.Message) (string, error) {
			received = message
			return "reply", nil
		}),
		downloadFile: func(context.Context, string) ([]byte, string, error) {
			return []byte("pdf"), "documents/report.pdf", nil
		},
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	message := privateMessage(42, "")
	message.Caption = " summarize "
	message.Document = &models.Document{
		FileID: "document", FileName: "report.pdf", MimeType: "application/pdf",
	}
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if received.Text != "summarize" || len(received.Attachments) != 1 {
		t.Fatalf("message = %#v", received)
	}
	attachment := received.Attachments[0]
	if attachment.Kind != gateway.AttachmentKindFile || string(attachment.Data) != "pdf" {
		t.Fatalf("attachment = %#v", attachment)
	}
}

func TestDownloadTelegramFile(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bot123:token/getFile":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "result": map[string]any{"file_id": "file", "file_path": "documents/report.pdf"},
			}); err != nil {
				t.Errorf("encode getFile response: %v", err)
			}
		case "/file/bot123:token/documents/report.pdf":
			if _, err := w.Write([]byte("pdf-data")); err != nil {
				t.Errorf("write file: %v", err)
			}
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)
	service, err := newService(Config{
		BotToken: "123:token", AllowedUserIDs: []int64{42},
	}, successfulResponder, tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}

	data, filePath, err := service.downloadTelegramFile(t.Context(), "file")
	if err != nil {
		t.Fatalf("downloadTelegramFile() error = %v", err)
	}
	if string(data) != "pdf-data" || filePath != "documents/report.pdf" {
		t.Fatalf("data = %q, path = %q", data, filePath)
	}
}

func TestDownloadTelegramFileRejectsRedirect(t *testing.T) {
	var followed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		followed.Store(true)
	}))
	t.Cleanup(target.Close)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bot123:token/getFile":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "result": map[string]any{"file_id": "file", "file_path": "redirect"},
			}); err != nil {
				t.Errorf("encode getFile response: %v", err)
			}
		case "/file/bot123:token/redirect":
			http.Redirect(w, request, target.URL, http.StatusFound)
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)
	service, err := newService(Config{
		BotToken: "123:token", AllowedUserIDs: []int64{42},
	}, successfulResponder, tgbot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}

	_, _, err = service.downloadTelegramFile(t.Context(), "file")
	if err == nil || !strings.Contains(err.Error(), "HTTP status 302") {
		t.Fatalf("downloadTelegramFile() error = %v", err)
	}
	if followed.Load() {
		t.Fatal("download followed redirect")
	}
}

func TestHandleMessageReturnsSafeReplyForDownloadError(t *testing.T) {
	responses := 0
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		responses++
		return "reply", nil
	})
	service.downloadFile = func(context.Context, string) ([]byte, string, error) {
		return nil, "", errors.New("secret download error")
	}
	message := privateMessage(42, "")
	message.Document = &models.Document{FileID: "document", FileName: "report.pdf", MimeType: "application/pdf"}
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if responses != 0 || len(sender.messages) != 1 || sender.messages[0].Text != errorReply {
		t.Fatalf("responses = %d, messages = %#v", responses, sender.messages)
	}
}

func TestHandleMessageShowsTypingBeforeAgentRun(t *testing.T) {
	sender := &fakeSender{}
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		if len(sender.actions) != 1 {
			t.Fatalf("typing actions before agent run = %d, want 1", len(sender.actions))
		}
		return "reply", nil
	})
	message := privateMessage(42, "hello")
	message.MessageThreadID = 7

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if sender.actions[0].ChatID != message.Chat.ID || sender.actions[0].MessageThreadID != 7 ||
		sender.actions[0].Action != models.ChatActionTyping {
		t.Fatalf("typing action = %#v", sender.actions[0])
	}
}

func TestRefreshTypingSendsOnTicksAndStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	ticks := make(chan time.Time)
	sender := &fakeSender{actionSignal: make(chan struct{}, 1)}
	params := &tgbot.SendChatActionParams{ChatID: int64(42), Action: models.ChatActionTyping}
	done := make(chan struct{})
	go func() {
		defer close(done)
		refreshTyping(ctx, sender, params, ticks)
	}()

	ticks <- time.Now()
	<-sender.actionSignal
	if len(sender.actions) != 1 || sender.actions[0] != params {
		t.Fatalf("actions = %#v", sender.actions)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("refreshTyping() did not stop after cancellation")
	}
}

func TestHandleMessageFormatsMarkdownReply(t *testing.T) {
	reply := "我可以使用以下工具：\n\n1. **读取文件 `read`**\n   - 查看文本内容"
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return reply, nil
	})
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "有哪些工具")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if len(sender.messages) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(sender.messages))
	}
	message := sender.messages[0]
	if strings.Contains(message.Text, "**") || strings.Contains(message.Text, "`") {
		t.Fatalf("message text contains Markdown markers: %q", message.Text)
	}
	if message.ParseMode != "" {
		t.Fatalf("parse mode = %q, want entities mode", message.ParseMode)
	}
	if !hasEntityType(message.Entities, models.MessageEntityTypeBold) ||
		!hasEntityType(message.Entities, models.MessageEntityTypeCode) {
		t.Fatalf("entities = %#v, want bold and code", message.Entities)
	}
}

func TestHandleMessageRetriesBadRichTextAsPlainText(t *testing.T) {
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return "**formatted reply**", nil
	})
	sender := &fakeSender{errors: []error{fmt.Errorf("%w, invalid entity", tgbot.ErrorBadRequest), nil}}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if sender.calls != 2 || len(sender.messages) != 1 {
		t.Fatalf("calls = %d, sent messages = %d", sender.calls, len(sender.messages))
	}
	if sender.messages[0].Text != "formatted reply" || len(sender.messages[0].Entities) != 0 {
		t.Fatalf("fallback message = %#v", sender.messages[0])
	}
}

func TestHandleMessageFallsBackWhenFormattedReplyIsEmpty(t *testing.T) {
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return "```\n \n```", nil
	})
	sender := &fakeSender{}
	message := privateMessage(42, "hello")
	message.ID = 99

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if len(sender.messages) != 1 || sender.messages[0].Text != emptyReply {
		t.Fatalf("sent messages = %#v", sender.messages)
	}
	if sender.messages[0].ReplyParameters == nil || sender.messages[0].ReplyParameters.MessageID != 99 {
		t.Fatalf("reply parameters = %#v", sender.messages[0].ReplyParameters)
	}
}

func TestHandleMessageFallsBackWhenTelegramRemovesFormattedReply(t *testing.T) {
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return "**&#1;**", nil
	})
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if len(sender.messages) != 1 || sender.messages[0].Text != emptyReply {
		t.Fatalf("sent messages = %#v", sender.messages)
	}
}

func TestHandleMessageRepliesAndSplitsLongText(t *testing.T) {
	const userID int64 = 42
	reply := strings.Repeat("中", maxMessageUTF16Units+1)
	service := testService([]int64{userID}, func(context.Context, string) (string, error) {
		return reply, nil
	})
	sender := &fakeSender{}
	message := privateMessage(userID, "hello")
	message.ID = 99

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if len(sender.messages) != 2 {
		t.Fatalf("sent messages = %d, want 2", len(sender.messages))
	}
	if count := tgmd.UTF16Len(sender.messages[0].Text); count != maxMessageUTF16Units {
		t.Fatalf("first chunk UTF-16 units = %d, want %d", count, maxMessageUTF16Units)
	}
	if sender.messages[0].ReplyParameters == nil || sender.messages[0].ReplyParameters.MessageID != 99 {
		t.Fatalf("first chunk reply parameters = %#v", sender.messages[0].ReplyParameters)
	}
	if sender.messages[1].ReplyParameters != nil {
		t.Fatalf("second chunk unexpectedly has reply parameters")
	}
	if sender.messages[0].Text+sender.messages[1].Text != reply {
		t.Fatal("message chunks did not preserve reply")
	}
}

func TestHandleMessageReturnsSafeErrorReply(t *testing.T) {
	agentErr := errors.New("secret upstream error")
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return "", agentErr
	})
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if len(sender.messages) != 1 || sender.messages[0].Text != errorReply {
		t.Fatalf("sent messages = %#v, want safe error reply", sender.messages)
	}
	if strings.Contains(sender.messages[0].Text, agentErr.Error()) {
		t.Fatal("error reply leaked internal error")
	}
}

func TestHandleMessageHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return "", context.Canceled
	})
	sender := &fakeSender{}

	err := service.handleMessage(ctx, sender, privateMessage(42, "hello"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("handleMessage() error = %v, want context canceled", err)
	}
	if len(sender.messages) != 0 {
		t.Fatalf("sent %d messages after cancellation", len(sender.messages))
	}
}

func TestHandleMessageRetriesRateLimitedChunk(t *testing.T) {
	reply := strings.Repeat("a", maxMessageUTF16Units+1)
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return reply, nil
	})
	waits := 0
	service.wait = func(_ context.Context, duration time.Duration) error {
		waits++
		if duration != 2*time.Second {
			t.Fatalf("retry duration = %v, want 2s", duration)
		}
		return nil
	}
	sender := &fakeSender{errors: []error{
		nil,
		&tgbot.TooManyRequestsError{Message: "rate limited", RetryAfter: 2},
		nil,
	}}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if sender.calls != 3 || len(sender.messages) != 2 || waits != 1 {
		t.Fatalf("calls = %d, messages = %d, waits = %d; want 3, 2, 1", sender.calls, len(sender.messages), waits)
	}
}

func TestHandleMessageSkipsWhitespaceChunks(t *testing.T) {
	reply := strings.Repeat("a", maxMessageUTF16Units) + strings.Repeat("\n", maxMessageUTF16Units) + "end"
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return reply, nil
	})
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if len(sender.messages) != 2 {
		t.Fatalf("sent messages = %d, want 2", len(sender.messages))
	}
	if sender.messages[0].ReplyParameters == nil || sender.messages[1].ReplyParameters != nil {
		t.Fatalf("reply parameters were not applied to the first actual message")
	}
	if sender.messages[1].Text != "\n\nend" {
		t.Fatalf("last message = %q, want %q", sender.messages[1].Text, "\n\nend")
	}
}

func TestSendChunkStopsWhenRetryWaitIsCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	sender := &fakeSender{errors: []error{
		&tgbot.TooManyRequestsError{Message: "rate limited", RetryAfter: 1},
	}}
	params := &tgbot.SendMessageParams{ChatID: int64(1), Text: "text"}

	err := sendChunk(ctx, sender, params, waitForRetry)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("sendChunk() error = %v, want context canceled", err)
	}
	if sender.calls != 1 {
		t.Fatalf("send calls = %d, want 1", sender.calls)
	}
}

func hasEntityType(entities []models.MessageEntity, want models.MessageEntityType) bool {
	for _, entity := range entities {
		if entity.Type == want {
			return true
		}
	}
	return false
}

type fakeSender struct {
	messages     []*tgbot.SendMessageParams
	actions      []*tgbot.SendChatActionParams
	actionSignal chan struct{}
	errors       []error
	calls        int
}

func (s *fakeSender) SendChatAction(_ context.Context, params *tgbot.SendChatActionParams) (bool, error) {
	s.actions = append(s.actions, params)
	if s.actionSignal != nil {
		s.actionSignal <- struct{}{}
	}
	return true, nil
}

func (s *fakeSender) SendMessage(_ context.Context, params *tgbot.SendMessageParams) (*models.Message, error) {
	call := s.calls
	s.calls++
	if call < len(s.errors) && s.errors[call] != nil {
		return nil, s.errors[call]
	}
	s.messages = append(s.messages, params)
	return &models.Message{}, nil
}

func testService(userIDs []int64, respond responder) *Service {
	allowedUserIDs := make(map[int64]struct{}, len(userIDs))
	for _, userID := range userIDs {
		allowedUserIDs[userID] = struct{}{}
	}
	return &Service{
		handler:        respond,
		wait:           waitForRetry,
		allowedUserIDs: allowedUserIDs,
		fatalErrors:    make(chan error, 1),
	}
}

func privateMessage(userID int64, text string) *models.Message {
	return message(userID, models.ChatTypePrivate, text)
}

func message(userID int64, chatType models.ChatType, text string) *models.Message {
	return &models.Message{
		ID:   1,
		From: &models.User{ID: userID},
		Chat: models.Chat{ID: userID, Type: chatType},
		Text: text,
	}
}

func newPollingTestServer(t *testing.T, getUpdates http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bot123:token/getMe":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"result": map[string]any{"id": 123, "is_bot": true, "first_name": "bot"},
			}); err != nil {
				t.Errorf("encode getMe response: %v", err)
			}
		case "/bot123:token/deleteWebhook":
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
				t.Errorf("encode deleteWebhook response: %v", err)
			}
		case "/bot123:token/getUpdates":
			getUpdates(w, request)
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

type responder func(context.Context, string) (string, error)

func (r responder) Handle(ctx context.Context, message gateway.Message) (string, error) {
	return r(ctx, message.Text)
}

var successfulResponder responder = func(context.Context, string) (string, error) {
	return "ok", nil
}
