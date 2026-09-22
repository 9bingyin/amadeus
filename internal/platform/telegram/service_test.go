package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/gateway"
	markdown "github.com/eekstunt/telegramify-markdown-go"
	bot "github.com/go-telegram/bot"
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
			_, err := newService(test.config, test.respond, bot.WithSkipGetMe())
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
	}, successfulResponder, bot.WithSkipGetMe())
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
	}, successfulResponder, bot.WithSkipGetMe())
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
	commandsRegistered := make(chan struct{})
	var once sync.Once
	var commandsOnce sync.Once
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
		case "/bot123:token/setMyCommands":
			commandsOnce.Do(func() { close(commandsRegistered) })
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
				t.Errorf("encode setMyCommands response: %v", err)
			}
		case "/bot123:token/getUpdates":
			select {
			case <-commandsRegistered:
			default:
				t.Error("polling started before Telegram commands were registered")
			}
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
	}, successfulResponder, bot.WithSkipGetMe(), bot.WithServerURL(server.URL))
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
	}), bot.WithServerURL(server.URL))
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
				currentStage := strings.TrimPrefix(request.URL.Path, "/bot123:token/")
				if currentStage == stage {
					once.Do(func() { close(started) })
					<-request.Context().Done()
					return
				}
				switch currentStage {
				case "getMe":
					if err := json.NewEncoder(w).Encode(map[string]any{
						"ok": true, "result": map[string]any{"id": 123, "is_bot": true, "first_name": "bot"},
					}); err != nil {
						t.Errorf("encode getMe response: %v", err)
					}
				case "deleteWebhook", "setMyCommands":
					if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
						t.Errorf("encode Telegram setup response: %v", err)
					}
				default:
					http.NotFound(w, request)
				}
			}))
			t.Cleanup(server.Close)
			service, err := newService(Config{
				BotToken: "123:token", AllowedUserIDs: []int64{42},
			}, successfulResponder, bot.WithServerURL(server.URL))
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
		case "/bot123:token/deleteWebhook", "/bot123:token/setMyCommands":
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
				t.Errorf("encode Telegram setup response: %v", err)
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
	}, successfulResponder, bot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- service.Run(t.Context()) }()
	select {
	case err := <-done:
		if err == nil || !errors.Is(err, bot.ErrorConflict) {
			t.Fatalf("Run() error = %v, want conflict", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not stop after permanent polling error")
	}
}

func TestRunFatalPollingErrorCancelsAsyncAgent(t *testing.T) {
	agentStarted := make(chan struct{})
	agentFinished := make(chan struct{})
	messageGateway, err := gateway.New(t.Context(), cancelingAgent{started: agentStarted, finished: agentFinished})
	if err != nil {
		t.Fatalf("gateway.New() error = %v", err)
	}
	var updates atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bot123:token/getMe":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "result": map[string]any{"id": 123, "is_bot": true, "first_name": "bot"},
			})
		case "/bot123:token/deleteWebhook", "/bot123:token/setMyCommands", "/bot123:token/sendChatAction":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true})
		case "/bot123:token/getUpdates":
			if updates.Add(1) == 1 {
				_ = json.NewEncoder(w).Encode(map[string]any{
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
				})
				return
			}
			<-agentStarted
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": false, "error_code": http.StatusConflict, "description": "Conflict",
			})
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)
	service, err := newService(Config{
		BotToken: "123:token", AllowedUserIDs: []int64{42},
	}, messageGateway, bot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}

	err = service.Run(t.Context())
	if err == nil || !errors.Is(err, bot.ErrorConflict) {
		t.Fatalf("Run() error = %v, want conflict", err)
	}
	select {
	case <-agentFinished:
	default:
		t.Fatal("agent did not finish after fatal polling error")
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
	}, successfulResponder, bot.WithServerURL(server.URL))
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
	}), bot.WithServerURL(server.URL))
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
		if !errors.Is(err, bot.ErrorUnauthorized) {
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
	}), bot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	service.attachmentsDir = t.TempDir()
	service.saveFile = func(context.Context, string, string) error {
		return fmt.Errorf("get file: %w", bot.ErrorUnauthorized)
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
		if !errors.Is(err, bot.ErrorUnauthorized) {
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
				if !strings.Contains(prompt, "hello") || !strings.HasPrefix(prompt, "[Telegram #") {
					t.Fatalf("prompt = %q", prompt)
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

func TestHandleMessageSubmitsWithoutWaitingForAgent(t *testing.T) {
	agentStarted := make(chan struct{})
	releaseAgent := make(chan struct{})
	messageSent := make(chan struct{}, 1)
	messageGateway, err := gateway.New(t.Context(), blockingAgent{
		started: agentStarted,
		release: releaseAgent,
	})
	if err != nil {
		t.Fatalf("gateway.New() error = %v", err)
	}
	service := &Service{
		handler:        messageGateway,
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	sender := &fakeSender{messageSignal: messageSent}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	select {
	case <-agentStarted:
	case <-time.After(time.Second):
		t.Fatal("agent did not start")
	}
	select {
	case <-messageSent:
		t.Fatal("response was sent before agent completed")
	default:
	}

	close(releaseAgent)
	select {
	case <-messageSent:
	case <-time.After(time.Second):
		t.Fatal("response was not sent after agent completed")
	}
	service.tasks.Wait()
	if len(sender.messages) != 1 || sender.messages[0].Text != "reply" {
		t.Fatalf("sent messages = %#v", sender.messages)
	}
}

func TestAsyncRepliesAreDeliveredInConversationOrder(t *testing.T) {
	messageGateway, err := gateway.New(t.Context(), &numberedAgent{})
	if err != nil {
		t.Fatalf("gateway.New() error = %v", err)
	}
	service := &Service{
		handler:        messageGateway,
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	sender := &orderedSender{
		firstStarted:  make(chan struct{}),
		releaseFirst:  make(chan struct{}),
		secondStarted: make(chan struct{}),
	}
	first := privateMessage(42, "first")
	first.ID = 10
	second := privateMessage(42, "second")
	second.ID = 11

	if err := service.handleMessage(t.Context(), sender, first); err != nil {
		t.Fatalf("first handleMessage() error = %v", err)
	}
	<-sender.firstStarted
	if err := service.handleMessage(t.Context(), sender, second); err != nil {
		t.Fatalf("second handleMessage() error = %v", err)
	}
	select {
	case <-sender.secondStarted:
		t.Fatal("second response started before first completed")
	case <-time.After(50 * time.Millisecond):
	}
	close(sender.releaseFirst)
	service.tasks.Wait()

	if got := sender.sentTexts(); !reflect.DeepEqual(got, []string{"reply-1", "reply-2"}) {
		t.Fatalf("sent replies = %#v", got)
	}
}

func TestAsyncAttachmentErrorWaitsForEarlierDelivery(t *testing.T) {
	messageGateway, err := gateway.New(t.Context(), &numberedAgent{})
	if err != nil {
		t.Fatalf("gateway.New() error = %v", err)
	}
	service := &Service{
		handler: messageGateway,
		saveFile: func(context.Context, string, string) error {
			return errors.New("download failed")
		},
		attachmentsDir: t.TempDir(),
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	sender := &orderedSender{
		firstStarted:  make(chan struct{}),
		releaseFirst:  make(chan struct{}),
		secondStarted: make(chan struct{}),
	}
	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "first")); err != nil {
		t.Fatalf("first handleMessage() error = %v", err)
	}
	<-sender.firstStarted
	second := privateMessage(42, "")
	second.Document = &models.Document{FileID: "file", FileName: "file.pdf"}
	if err := service.handleMessage(t.Context(), sender, second); err != nil {
		t.Fatalf("second handleMessage() error = %v", err)
	}
	select {
	case <-sender.secondStarted:
		t.Fatal("attachment error was sent before first response completed")
	case <-time.After(50 * time.Millisecond):
	}
	close(sender.releaseFirst)
	service.tasks.Wait()

	if got := sender.sentTexts(); !reflect.DeepEqual(got, []string{"reply-1", "reply-2"}) {
		t.Fatalf("sent replies = %#v", got)
	}
}

func TestAsyncGatewayTaskWaitsForAgentCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	agentStarted := make(chan struct{})
	agentFinished := make(chan struct{})
	messageGateway, err := gateway.New(ctx, cancelingAgent{started: agentStarted, finished: agentFinished})
	if err != nil {
		t.Fatalf("gateway.New() error = %v", err)
	}
	service := &Service{
		handler:        messageGateway,
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	sender := &fakeSender{}
	if err := service.handleMessage(ctx, sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	<-agentStarted
	cancel()

	tasksDone := make(chan struct{})
	go func() {
		service.tasks.Wait()
		close(tasksDone)
	}()
	select {
	case <-agentFinished:
	case <-time.After(time.Second):
		t.Fatal("agent did not observe cancellation")
	}
	select {
	case <-tasksDone:
	case <-time.After(time.Second):
		t.Fatal("response task did not wait for agent shutdown")
	}
	if len(sender.messages) != 0 {
		t.Fatalf("sent messages = %d, want 0", len(sender.messages))
	}
}

func TestHandleMessageDeliversOnlyLatestJoinedMessage(t *testing.T) {
	agentStarted := make(chan struct{})
	releaseAgent := make(chan struct{})
	messageGateway, err := gateway.New(t.Context(), &joiningAgent{started: agentStarted, release: releaseAgent})
	if err != nil {
		t.Fatalf("gateway.New() error = %v", err)
	}
	service := &Service{
		handler:        messageGateway,
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	sender := &fakeSender{messageSignal: make(chan struct{}, 2)}
	first := privateMessage(42, "first")
	first.ID = 10
	second := privateMessage(42, "second")
	second.ID = 11

	if err := service.handleMessage(t.Context(), sender, first); err != nil {
		t.Fatalf("first handleMessage() error = %v", err)
	}
	<-agentStarted
	if err := service.handleMessage(t.Context(), sender, second); err != nil {
		t.Fatalf("second handleMessage() error = %v", err)
	}
	close(releaseAgent)
	service.tasks.Wait()

	if len(sender.messages) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(sender.messages))
	}
	params := sender.messages[0]
	if params.Text != "first,second" {
		t.Fatalf("reply = %q", params.Text)
	}
	if params.ReplyParameters == nil || params.ReplyParameters.MessageID != 11 {
		t.Fatalf("reply parameters = %#v", params.ReplyParameters)
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
	if received.Platform != "telegram" || received.ConversationID != "100" || received.SenderID != "42" {
		t.Fatalf("message = %#v", received)
	}
	if !strings.HasPrefix(received.Text, "[Telegram #") || !strings.Contains(received.Text, "hello") {
		t.Fatalf("text = %q", received.Text)
	}
}

func TestInboundAttachments(t *testing.T) {
	tests := []struct {
		name          string
		message       *models.Message
		wantFileID    string
		downloadData  []byte
		wantKind      gateway.AttachmentKind
		wantMediaType string
		wantFilename  string
		wantAttached  bool
	}{
		{
			name: "largest photo",
			message: &models.Message{
				ID: 188, Chat: models.Chat{ID: 100},
				Photo: []models.PhotoSize{
					{FileID: "small", FileUniqueID: "s", Width: 100, Height: 100, FileSize: 100},
					{FileID: "large", FileUniqueID: "abc", Width: 1000, Height: 1000, FileSize: 1000},
				},
			},
			wantFileID: "large", wantKind: gateway.AttachmentKindImage,
			wantMediaType: "image/jpeg", wantFilename: "photo.jpg", wantAttached: true,
		},
		{
			name: "image document",
			message: &models.Message{
				ID: 188, Chat: models.Chat{ID: 100},
				Document: &models.Document{
					FileID: "image", FileUniqueID: "png", FileName: "diagram.png", MimeType: "image/png",
				},
			},
			wantFileID: "image", wantKind: gateway.AttachmentKindImage,
			wantMediaType: "image/png", wantFilename: "diagram.png", wantAttached: true,
		},
		{
			name: "generic MIME image document",
			message: &models.Message{
				ID: 188, Chat: models.Chat{ID: 100},
				Document: &models.Document{
					FileID: "generic-image", FileUniqueID: "bin", FileName: "diagram.png", MimeType: "application/octet-stream",
				},
			},
			wantFileID: "generic-image", downloadData: []byte("\x89PNG\r\n\x1a\nimage"),
			wantKind: gateway.AttachmentKindImage, wantMediaType: "image/png", wantFilename: "diagram.png",
			wantAttached: true,
		},
		{
			name: "csv document",
			message: &models.Message{
				ID: 188, Chat: models.Chat{ID: 100},
				Document: &models.Document{
					FileID: "csv", FileUniqueID: "csv", FileName: "metrics.csv", MimeType: "application/octet-stream",
				},
			},
			wantFileID: "csv", downloadData: []byte("BMI,age\n22,30\n"),
			wantKind: gateway.AttachmentKindFile, wantMediaType: canonicalDeclaredMediaType(mime.TypeByExtension(".csv")),
			wantFilename: "metrics.csv", wantAttached: true,
		},
		{
			name: "PDF document",
			message: &models.Message{
				ID: 188, Chat: models.Chat{ID: 100},
				Document: &models.Document{
					FileID: "pdf", FileUniqueID: "pdf", FileName: "report.pdf", MimeType: "application/pdf",
				},
			},
			wantFileID: "pdf", wantKind: gateway.AttachmentKindFile,
			wantMediaType: "application/pdf", wantFilename: "report.pdf", wantAttached: true,
		},
		{
			name: "zip document is path only",
			message: &models.Message{
				ID: 188, Chat: models.Chat{ID: 100},
				Document: &models.Document{
					FileID: "zip", FileUniqueID: "zip", FileName: "bundle.zip", MimeType: "application/zip",
				},
			},
			wantFileID: "zip",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			data := test.downloadData
			if data == nil {
				data = []byte(test.wantFileID)
			}
			var downloadedFileID string
			service := &Service{
				attachmentsDir: dir,
				saveFile: func(_ context.Context, dest, fileID string) error {
					downloadedFileID = fileID
					if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
						return err
					}
					return os.WriteFile(dest, data, 0o600)
				},
			}
			test.message.From = &models.User{ID: 42, FirstName: "Alice"}
			inbound, err := service.inbound(t.Context(), test.message)
			if err != nil {
				t.Fatalf("inbound() error = %v", err)
			}
			if downloadedFileID != test.wantFileID {
				t.Fatalf("file ID = %q, want %q", downloadedFileID, test.wantFileID)
			}
			if !strings.Contains(inbound.Text, dir) {
				t.Fatalf("text = %q, want path under %q", inbound.Text, dir)
			}
			if !test.wantAttached {
				if len(inbound.Attachments) != 0 {
					t.Fatalf("attachments = %#v, want none", inbound.Attachments)
				}
				return
			}
			if len(inbound.Attachments) != 1 {
				t.Fatalf("attachments = %#v", inbound.Attachments)
			}
			attachment := inbound.Attachments[0]
			if attachment.Kind != test.wantKind || attachment.MediaType != test.wantMediaType ||
				attachment.Filename != test.wantFilename || attachment.Path == "" || len(attachment.Data) != 0 {
				t.Fatalf("attachment = %#v", attachment)
			}
			if _, err := os.Stat(attachment.Path); err != nil {
				t.Fatalf("saved file: %v", err)
			}
		})
	}
}

func TestHandleMessageForwardsCaptionAndDocument(t *testing.T) {
	dir := t.TempDir()
	var received gateway.Message
	service := &Service{
		handler: gateway.HandlerFunc(func(_ context.Context, message gateway.Message) (string, error) {
			received = message
			return "reply", nil
		}),
		attachmentsDir: dir,
		saveFile: func(_ context.Context, dest, _ string) error {
			if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
				return err
			}
			return os.WriteFile(dest, []byte("pdf"), 0o600)
		},
		wait:           waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}},
		fatalErrors:    make(chan error, 1),
	}
	message := privateMessage(42, "")
	message.Caption = " summarize "
	message.Document = &models.Document{
		FileID: "document", FileUniqueID: "pdf", FileName: "report.pdf", MimeType: "application/pdf",
	}
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if !strings.Contains(received.Text, "summarize") || !strings.HasPrefix(received.Text, "[Telegram #") ||
		len(received.Attachments) != 1 {
		t.Fatalf("message = %#v", received)
	}
	attachment := received.Attachments[0]
	if attachment.Kind != gateway.AttachmentKindFile || attachment.Path == "" || len(attachment.Data) != 0 {
		t.Fatalf("attachment = %#v", attachment)
	}
}

func TestSaveTelegramFile(t *testing.T) {
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
		BotToken: "123:token", AllowedUserIDs: []int64{42}, AttachmentsDir: t.TempDir(),
	}, successfulResponder, bot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	dest := filepath.Join(t.TempDir(), "report.pdf")
	if err := service.saveTelegramFile(t.Context(), dest, "file"); err != nil {
		t.Fatalf("saveTelegramFile() error = %v", err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(data) != "pdf-data" {
		t.Fatalf("data = %q", data)
	}
	if err := service.saveTelegramFile(t.Context(), dest, "file"); err != nil {
		t.Fatalf("cached saveTelegramFile() error = %v", err)
	}
}

func TestSaveTelegramFileRejectsRedirect(t *testing.T) {
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
	}, successfulResponder, bot.WithServerURL(server.URL))
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	err = service.saveTelegramFile(t.Context(), filepath.Join(t.TempDir(), "file.bin"), "file")
	if err == nil || !strings.Contains(err.Error(), "HTTP status 302") {
		t.Fatalf("saveTelegramFile() error = %v", err)
	}
	if followed.Load() {
		t.Fatal("download followed redirect")
	}
}

func TestHandleMessageKeepsUnavailableAttachment(t *testing.T) {
	var prompt string
	service := testService([]int64{42}, func(_ context.Context, text string) (string, error) {
		prompt = text
		return "reply", nil
	})
	service.attachmentsDir = t.TempDir()
	service.saveFile = func(context.Context, string, string) error {
		return errors.New("secret download error")
	}
	message := privateMessage(42, "")
	message.Document = &models.Document{FileID: "document", FileName: "report.pdf", MimeType: "application/pdf"}
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if prompt == "" || !strings.Contains(prompt, "[document attachment unavailable]") {
		t.Fatalf("prompt = %q", prompt)
	}
	if len(sender.messages) != 1 || sender.messages[0].Text != "reply" {
		t.Fatalf("messages = %#v", sender.messages)
	}
}

func TestHandleMessageSubmitsMetadataOnly(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*models.Message)
		want   string
	}{
		{
			name: "sticker",
			mutate: func(message *models.Message) {
				message.Sticker = &models.Sticker{Emoji: "😀", SetName: "HotCherry"}
			},
			want: `[Sticker 😀 from "HotCherry"]`,
		},
		{
			name: "location",
			mutate: func(message *models.Message) {
				message.Location = &models.Location{Latitude: 39.9042, Longitude: 116.407396}
			},
			want: "[Location 39.904200, 116.407396]",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var received gateway.Message
			service := testService([]int64{42}, func(_ context.Context, prompt string) (string, error) {
				received.Text = prompt
				return "reply", nil
			})
			message := privateMessage(42, "")
			test.mutate(message)
			if err := service.handleMessage(t.Context(), &fakeSender{}, message); err != nil {
				t.Fatalf("handleMessage() error = %v", err)
			}
			if !strings.HasPrefix(received.Text, "[Telegram #") || !strings.Contains(received.Text, test.want) {
				t.Fatalf("text = %q", received.Text)
			}
		})
	}
}

func TestInboundSkipsOversizeDocument(t *testing.T) {
	called := false
	service := &Service{
		attachmentsDir: t.TempDir(),
		saveFile: func(context.Context, string, string) error {
			called = true
			return nil
		},
	}
	message := &models.Message{
		ID: 1, From: &models.User{ID: 42, FirstName: "Alice"},
		Chat: models.Chat{ID: 100},
		Document: &models.Document{
			FileID: "huge", FileUniqueID: "huge", FileName: "movie.bin",
			MimeType: "application/octet-stream", FileSize: maxAttachmentBytes + 1,
		},
	}
	inbound, err := service.inbound(t.Context(), message)
	if err != nil {
		t.Fatalf("inbound() error = %v", err)
	}
	if called {
		t.Fatal("saveFile called for oversize document")
	}
	if len(inbound.Attachments) != 0 || !strings.Contains(inbound.Text, "[document attachment unavailable]") {
		t.Fatalf("inbound = %#v", inbound)
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

func TestContinueTypingSendsAgainWithoutStopping(t *testing.T) {
	sender := &fakeSender{}
	service := &Service{}
	message := privateMessage(42, "hello")
	message.MessageThreadID = 7
	stop := service.acquireTyping(t.Context(), sender, message)
	defer stop()
	service.continueTyping(message.Chat.ID, message.MessageThreadID)
	if len(sender.actions) != 2 || sender.actions[1].Action != models.ChatActionTyping {
		t.Fatalf("typing actions = %#v", sender.actions)
	}
}

func TestRefreshTypingSendsOnTicksAndStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	ticks := make(chan time.Time)
	sender := &fakeSender{actionSignal: make(chan struct{}, 1)}
	params := &bot.SendChatActionParams{ChatID: int64(42), Action: models.ChatActionTyping}
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
	sender := &fakeSender{errors: []error{fmt.Errorf("%w, invalid entity", bot.ErrorBadRequest), nil}}

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
	if count := markdown.UTF16Len(sender.messages[0].Text); count != maxMessageUTF16Units {
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

func TestHandleMessageReturnsErrorText(t *testing.T) {
	agentErr := errors.New("secret upstream error")
	service := testService([]int64{42}, func(context.Context, string) (string, error) {
		return "", agentErr
	})
	sender := &fakeSender{}

	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "hello")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	if len(sender.messages) != 1 || sender.messages[0].Text != agentErr.Error() {
		t.Fatalf("sent messages = %#v, want %q", sender.messages, agentErr.Error())
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
		&bot.TooManyRequestsError{Message: "rate limited", RetryAfter: 2},
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
		&bot.TooManyRequestsError{Message: "rate limited", RetryAfter: 1},
	}}
	params := &bot.SendMessageParams{ChatID: int64(1), Text: "text"}

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

type commandHandler struct {
	newReferences     []gateway.ConversationReference
	compactReferences []gateway.ConversationReference
	statusReferences  []gateway.ConversationReference
	compactErr        error
	handleCalls       int
}

func (h *commandHandler) Handle(context.Context, gateway.Message) (string, error) {
	h.handleCalls++
	return "unexpected", nil
}

func (h *commandHandler) NewConversation(
	_ context.Context,
	reference gateway.ConversationReference,
) error {
	h.newReferences = append(h.newReferences, reference)
	return nil
}

func (h *commandHandler) CompactConversation(
	_ context.Context,
	reference gateway.ConversationReference,
) error {
	h.compactReferences = append(h.compactReferences, reference)
	return h.compactErr
}

func (h *commandHandler) StatusConversation(
	_ context.Context,
	reference gateway.ConversationReference,
) error {
	h.statusReferences = append(h.statusReferences, reference)
	return nil
}

type durableCommandHandler struct {
	commandHandler
}

func (*durableCommandHandler) UsesDurableCommandReplies() {}

func TestFormatConversationStatus(t *testing.T) {
	status := gateway.ConversationStatus{
		SessionID: "82e071d8-14fa-4789-93fd-2ef783c0be3a",
		Provider:  "openai-responses", Model: "gpt-5.6-luna", ReasoningEffort: "high",
		EstimatedContextTokens: 28_741, ContextWindowTokens: 128_000,
	}
	want := "会话 ID：82e071d8-14fa-4789-93fd-2ef783c0be3a\n" +
		"模型：openai-responses/gpt-5.6-luna\n" +
		"推理强度：high\n" +
		"上下文：28,741 / 128,000 tokens\n" +
		"缓存率：—"
	if got := formatConversationStatus(status); got != want {
		t.Fatalf("formatConversationStatus() = %q, want %q", got, want)
	}
	status.InputTokens = 28_600
	status.CachedInputTokens = 12_345
	want = "会话 ID：82e071d8-14fa-4789-93fd-2ef783c0be3a\n" +
		"模型：openai-responses/gpt-5.6-luna\n" +
		"推理强度：high\n" +
		"上下文：28,741 / 128,000 tokens\n" +
		"缓存率：43.1%（12,345 / 28,600 tokens）"
	if got := formatConversationStatus(status); got != want {
		t.Fatalf("formatConversationStatus() = %q, want %q", got, want)
	}
	status.Embedding = &gateway.EmbeddingProgress{Done: 40, Total: 120, Phase: gateway.EmbeddingIndexing}
	want += "\n嵌入：40/120 （嵌入中）"
	if got := formatConversationStatus(status); got != want {
		t.Fatalf("formatConversationStatus() = %q, want %q", got, want)
	}
	status.Embedding = &gateway.EmbeddingProgress{Done: 120, Total: 120, Phase: gateway.EmbeddingWaiting}
	if got := embeddingLabel(120, 120, gateway.EmbeddingWaiting); got != "已完成" {
		t.Fatalf("embeddingLabel() = %q, want 已完成", got)
	}
	if got := embeddingLabel(40, 120, gateway.EmbeddingWaiting); got != "等待重试" {
		t.Fatalf("embeddingLabel() = %q, want 等待重试", got)
	}
	if got := embeddingLabel(0, 120, gateway.EmbeddingRebuilding); got != "重建中" {
		t.Fatalf("embeddingLabel() = %q, want 重建中", got)
	}
}

func TestHandleConversationCommandDoesNotDuplicateDurableReply(t *testing.T) {
	handler := &durableCommandHandler{}
	service := &Service{
		handler: handler, wait: waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}}, fatalErrors: make(chan error, 1),
	}
	service.accountID.Store(123)
	sender := &fakeSender{}
	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "/new")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	service.tasks.Wait()
	if len(handler.newReferences) != 1 || len(sender.messages) != 0 {
		t.Fatalf("durable command result = refs %#v, messages %#v", handler.newReferences, sender.messages)
	}
}

func TestHandleConversationCommands(t *testing.T) {
	handler := &commandHandler{}
	service := &Service{
		handler: handler, wait: waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}}, fatalErrors: make(chan error, 1),
		botUsername: "amadeus_bot",
	}
	service.accountID.Store(123)
	sender := &fakeSender{}
	newMessage := privateMessage(42, "/new@amadeus_bot")
	newMessage.ID = 10
	if err := service.handleMessage(t.Context(), sender, newMessage); err != nil {
		t.Fatalf("handleMessage() /new error = %v", err)
	}
	service.tasks.Wait()
	if len(handler.newReferences) != 1 || handler.newReferences[0].SourceEventID != "42:10" ||
		handler.handleCalls != 0 || len(sender.messages) != 1 || sender.messages[0].Text != newConversationReply {
		t.Fatalf("/new result = refs %#v, calls %d, messages %#v", handler.newReferences, handler.handleCalls, sender.messages)
	}

	handler.compactErr = gateway.ErrConversationNotCompactable
	compactMessage := privateMessage(42, "/compact")
	compactMessage.ID = 11
	if err := service.handleMessage(t.Context(), sender, compactMessage); err != nil {
		t.Fatalf("handleMessage() /compact error = %v", err)
	}
	service.tasks.Wait()
	if len(handler.compactReferences) != 1 || handler.compactReferences[0].SourceEventID != "42:11" ||
		len(sender.messages) != 2 || sender.messages[1].Text != nothingToCompactReply {
		t.Fatalf("/compact result = refs %#v, messages %#v", handler.compactReferences, sender.messages)
	}

	statusMessage := privateMessage(42, "/status@amadeus_bot")
	statusMessage.ID = 12
	if err := service.handleMessage(t.Context(), sender, statusMessage); err != nil {
		t.Fatalf("handleMessage() /status error = %v", err)
	}
	service.tasks.Wait()
	if len(handler.statusReferences) != 1 || handler.statusReferences[0].SourceEventID != "42:12" ||
		handler.statusReferences[0].FormatStatus == nil || len(sender.messages) != 3 ||
		sender.messages[2].Text != statusConversationReply {
		t.Fatalf("/status result = refs %#v, messages %#v", handler.statusReferences, sender.messages)
	}

	argumentMessage := privateMessage(42, "/new now")
	argumentMessage.ID = 13
	if err := service.handleMessage(t.Context(), sender, argumentMessage); err != nil {
		t.Fatalf("handleMessage() /new args error = %v", err)
	}
	service.tasks.Wait()
	if len(handler.newReferences) != 1 || len(sender.messages) != 4 || sender.messages[3].Text != commandUsageReply {
		t.Fatalf("/new args result = refs %#v, messages %#v", handler.newReferences, sender.messages)
	}
}

func TestHandleScheduleCommand(t *testing.T) {
	service := &Service{
		handler: &commandHandler{}, wait: waitForRetry,
		allowedUserIDs: map[int64]struct{}{42: {}}, fatalErrors: make(chan error, 1),
		botUsername: "amadeus_bot",
	}
	service.accountID.Store(123)
	sender := &fakeSender{}
	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "/schedule")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	service.tasks.Wait()
	if len(sender.messages) != 1 || sender.messages[0].Text != "定时任务不可用。" {
		t.Fatalf("missing list = %#v", sender.messages)
	}

	service.SetTaskList(func(_ context.Context, platform, accountID, chatID, threadID string) (string, error) {
		if platform != "telegram" || accountID != "123" || chatID != "42" || threadID != "" {
			t.Fatalf("route = %s %s %s %q", platform, accountID, chatID, threadID)
		}
		return "Schedule #1 还在 · every 30m · 下次 2026-09-22T17:00:00Z", nil
	})
	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "/schedule@amadeus_bot")); err != nil {
		t.Fatalf("handleMessage() listed error = %v", err)
	}
	service.tasks.Wait()
	if len(sender.messages) != 2 || !strings.Contains(sender.messages[1].Text, "Schedule #1 还在") {
		t.Fatalf("listed = %#v", sender.messages)
	}
	if err := service.handleMessage(t.Context(), sender, privateMessage(42, "/schedule now")); err != nil {
		t.Fatalf("handleMessage() args error = %v", err)
	}
	service.tasks.Wait()
	if len(sender.messages) != 3 || sender.messages[2].Text != commandUsageReply {
		t.Fatalf("args = %#v", sender.messages)
	}
}

type fakeSender struct {
	messages      []*bot.SendMessageParams
	actions       []*bot.SendChatActionParams
	actionSignal  chan struct{}
	messageSignal chan struct{}
	errors        []error
	calls         int
}

func (s *fakeSender) SendChatAction(_ context.Context, params *bot.SendChatActionParams) (bool, error) {
	s.actions = append(s.actions, params)
	if s.actionSignal != nil {
		s.actionSignal <- struct{}{}
	}
	return true, nil
}

func (s *fakeSender) SendMessage(_ context.Context, params *bot.SendMessageParams) (*models.Message, error) {
	call := s.calls
	s.calls++
	if call < len(s.errors) && s.errors[call] != nil {
		return nil, s.errors[call]
	}
	s.messages = append(s.messages, params)
	if s.messageSignal != nil {
		s.messageSignal <- struct{}{}
	}
	return &models.Message{}, nil
}

type numberedAgent struct {
	calls atomic.Int32
}

func (a *numberedAgent) Run(context.Context, gateway.Message) (string, error) {
	return fmt.Sprintf("reply-%d", a.calls.Add(1)), nil
}

type orderedSender struct {
	mu            sync.Mutex
	calls         int
	texts         []string
	firstStarted  chan struct{}
	releaseFirst  chan struct{}
	secondStarted chan struct{}
}

func (s *orderedSender) SendChatAction(context.Context, *bot.SendChatActionParams) (bool, error) {
	return true, nil
}

func (s *orderedSender) SendMessage(_ context.Context, params *bot.SendMessageParams) (*models.Message, error) {
	s.mu.Lock()
	s.calls++
	call := s.calls
	s.mu.Unlock()
	switch call {
	case 1:
		close(s.firstStarted)
		<-s.releaseFirst
	case 2:
		close(s.secondStarted)
	}
	s.mu.Lock()
	s.texts = append(s.texts, params.Text)
	s.mu.Unlock()
	return &models.Message{}, nil
}

func (s *orderedSender) sentTexts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.texts...)
}

type cancelingAgent struct {
	started  chan struct{}
	finished chan struct{}
}

func (a cancelingAgent) Run(ctx context.Context, _ gateway.Message) (string, error) {
	close(a.started)
	<-ctx.Done()
	close(a.finished)
	return "", ctx.Err()
}

type joiningAgent struct {
	started chan struct{}
	release chan struct{}
}

func (a *joiningAgent) Run(context.Context, gateway.Message) (string, error) {
	return "", errors.New("unexpected legacy run")
}

func (a *joiningAgent) RunConversation(
	_ context.Context,
	initial []gateway.Message,
	inbox agent.Inbox,
) (string, error) {
	close(a.started)
	<-a.release
	messages := append([]gateway.Message(nil), initial...)
	for {
		pending, sealed := inbox.DrainOrSeal()
		messages = append(messages, pending...)
		if sealed {
			break
		}
	}
	texts := make([]string, len(messages))
	for index, message := range messages {
		texts[index] = inboundTextBody(message.Text)
	}
	return strings.Join(texts, ","), nil
}

func inboundTextBody(text string) string {
	_, rest, ok := strings.Cut(text, "] ")
	if !ok {
		return text
	}
	if index := strings.LastIndex(rest, "\n"); index >= 0 {
		return rest[index+1:]
	}
	return rest
}

type blockingAgent struct {
	started chan struct{}
	release chan struct{}
}

func (a blockingAgent) Run(ctx context.Context, _ gateway.Message) (string, error) {
	close(a.started)
	select {
	case <-a.release:
		return "reply", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
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
		case "/bot123:token/deleteWebhook", "/bot123:token/setMyCommands":
			if err := json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": true}); err != nil {
				t.Errorf("encode Telegram setup response: %v", err)
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
