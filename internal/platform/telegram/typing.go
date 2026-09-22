package telegram

import (
	"context"
	"log/slog"
	"sync"
	"time"

	bot "github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

const typingRefreshInterval = 4 * time.Second

func (s *Service) acquireTyping(ctx context.Context, sender messageSender, message *models.Message) func() {
	key := typingKey{chatID: message.Chat.ID, threadID: message.MessageThreadID}
	s.typingMu.Lock()
	state := s.typings[key]
	if state == nil {
		if s.typings == nil {
			s.typings = make(map[typingKey]*sharedTyping)
		}
		stop, refresh := startTyping(ctx, sender, message)
		state = &sharedTyping{references: 1, stop: stop, refresh: refresh}
		s.typings[key] = state
	} else {
		state.references++
	}
	s.typingMu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			s.releaseTyping(key, state)
		})
	}
}

func (s *Service) continueTyping(chatID int64, threadID int) {
	if s == nil {
		return
	}
	key := typingKey{chatID: chatID, threadID: threadID}
	s.typingMu.Lock()
	state := s.typings[key]
	var refresh func()
	if state != nil {
		refresh = state.refresh
	}
	s.typingMu.Unlock()
	if refresh != nil {
		refresh()
	}
}

func (s *Service) releaseTyping(key typingKey, expected *sharedTyping) {
	s.typingMu.Lock()
	state := s.typings[key]
	if state != expected {
		s.typingMu.Unlock()
		return
	}
	state.references--
	if state.references > 0 {
		s.typingMu.Unlock()
		return
	}
	delete(s.typings, key)
	stop := state.stop
	s.typingMu.Unlock()
	stop()
}

func startTyping(ctx context.Context, sender messageSender, message *models.Message) (func(), func()) {
	typingCtx, cancel := context.WithCancel(ctx)
	params := &bot.SendChatActionParams{
		ChatID:          message.Chat.ID,
		MessageThreadID: message.MessageThreadID,
		Action:          models.ChatActionTyping,
	}
	sendTyping(typingCtx, sender, params)

	ticker := time.NewTicker(typingRefreshInterval)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer ticker.Stop()
		refreshTyping(typingCtx, sender, params, ticker.C)
	}()

	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
	refresh := func() {
		sendTyping(typingCtx, sender, params)
	}
	return stop, refresh
}

func refreshTyping(
	ctx context.Context,
	sender messageSender,
	params *bot.SendChatActionParams,
	ticks <-chan time.Time,
) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			sendTyping(ctx, sender, params)
		}
	}
}

func sendTyping(ctx context.Context, sender messageSender, params *bot.SendChatActionParams) {
	slog.DebugContext(ctx, "Sending Telegram chat action", "request", params)
	sent, err := sender.SendChatAction(ctx, params)
	if err != nil {
		if ctx.Err() != nil {
			slog.DebugContext(ctx, "Telegram chat action canceled", "err", err)
			return
		}
		slog.WarnContext(ctx, "Send Telegram chat action", "err", err)
		return
	}
	if !sent {
		slog.WarnContext(ctx, "Telegram chat action was not accepted", "request", params)
	}
}
