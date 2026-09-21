package telegram

import (
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/go-telegram/bot/models"
)

func TestFormatInboundEnvelope(t *testing.T) {
	sent := time.Date(2026, time.September, 21, 15, 39, 54, 0, time.UTC)
	alice := &models.User{ID: 42, FirstName: "Alice", Username: "alice"}
	header := func(id int) string {
		return "[Telegram #" + strconv.Itoa(id) + " Alice (@alice) id:42 Mon 2026-09-21 15:39:54Z]"
	}
	base := func(id int, text string) *models.Message {
		return &models.Message{
			ID: id, Date: int(sent.Unix()), From: alice,
			Chat: models.Chat{ID: 100, Type: models.ChatTypePrivate},
			Text: text,
		}
	}

	t.Run("text", func(t *testing.T) {
		got := formatInboundEnvelope(base(187, "这是什么"), "")
		want := header(187) + " 这是什么"
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
	t.Run("brackets in body", func(t *testing.T) {
		got := formatInboundEnvelope(base(187, "keep [this]"), "")
		if !strings.HasSuffix(got, " keep [this]") {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("image path", func(t *testing.T) {
		message := base(188, "")
		got := formatInboundEnvelope(message, "[image /tmp/188-abc.jpg]")
		if got != header(188)+" [image /tmp/188-abc.jpg]" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("image caption", func(t *testing.T) {
		message := base(188, "")
		message.Caption = "看这张"
		got := formatInboundEnvelope(message, "[image /tmp/188-abc.jpg]")
		if got != header(188)+" 看这张\n[image /tmp/188-abc.jpg]" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("voice caption unavailable", func(t *testing.T) {
		message := base(191, "")
		message.Caption = "听这个"
		got := formatInboundEnvelope(message, "[audio attachment unavailable]")
		if got != header(191)+" 听这个\n[audio attachment unavailable]" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("sticker", func(t *testing.T) {
		message := base(192, "")
		message.Sticker = &models.Sticker{Emoji: "😀", SetName: "HotCherry"}
		got := formatInboundEnvelope(message, formatSticker(message.Sticker))
		if got != header(192)+` [Sticker 😀 from "HotCherry"]` {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("reply and forward", func(t *testing.T) {
		message := base(187, "这是什么")
		message.ReplyToMessage = &models.Message{ID: 186, Text: "原文"}
		message.ForwardOrigin = &models.MessageOrigin{
			Type: models.MessageOriginTypeChannel,
			MessageOriginChannel: &models.MessageOriginChannel{
				Date: int(time.Date(2026, time.September, 21, 13, 58, 44, 0, time.UTC).Unix()),
				Chat: models.Chat{Title: "Example Channel", Username: "example"},
			},
		}
		got := formatInboundEnvelope(message, "")
		want := header(187) + "\n[Replying to: \"原文\"]\n[Forwarded from Example Channel (@example) at 2026-09-21 13:58:44Z]\n这是什么"
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
	t.Run("location and venue", func(t *testing.T) {
		message := base(193, "")
		message.Location = &models.Location{Latitude: 39.9042, Longitude: 116.407396, HorizontalAccuracy: 50}
		got := formatInboundEnvelope(message, "")
		if got != header(193)+" [Location 39.904200, 116.407396 ±50m]" {
			t.Fatalf("got %q", got)
		}
		message.Venue = &models.Venue{
			Location: models.Location{Latitude: 39.9042, Longitude: 116.407396},
			Title:    "Forbidden City", Address: "4 Jingshan Front St",
		}
		got = formatInboundEnvelope(message, "")
		if got != header(193)+" [Location 39.904200, 116.407396 Forbidden City, 4 Jingshan Front St]" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("poll", func(t *testing.T) {
		message := base(194, "")
		message.Poll = &models.Poll{
			Question: "Lunch?", Type: "regular", IsAnonymous: true,
			Options: []models.PollOption{{Text: "Pizza", VoterCount: 2}, {Text: "Salad", VoterCount: 1}},
		}
		got := formatInboundEnvelope(message, "")
		want := header(194) + " [Poll] Lunch?\n- Pizza (2 votes)\n- Salad (1 votes)\nType: regular\nVisibility: anonymous\nSelection: single\nStatus: open"
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
	t.Run("text link", func(t *testing.T) {
		message := base(195, "see here")
		start := utf16Index("see here", "here")
		message.Entities = []models.MessageEntity{{
			Type: models.MessageEntityTypeTextLink, Offset: start, Length: utf16Len("here"),
			URL: "https://example.com",
		}}
		got := formatInboundEnvelope(message, "")
		if got != header(195)+" see here (https://example.com)" {
			t.Fatalf("got %q", got)
		}
	})
}

func utf16Len(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func utf16Index(text, sub string) int {
	index := strings.Index(text, sub)
	return utf16Len(text[:index])
}
