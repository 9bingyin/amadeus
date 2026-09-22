package telegram

import (
	"strings"
	"testing"

	markdown "github.com/eekstunt/telegramify-markdown-go"
)

func TestFormatTelegramReplyNormalizesCommonMarkText(t *testing.T) {
	messages := formatTelegramReply(`\*x\* &amp; **b** and ` + "`\\* &amp;`")
	if len(messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(messages))
	}
	if messages[0].Text != `*x* & b and \* &amp;` {
		t.Fatalf("text = %q", messages[0].Text)
	}
	if len(messages[0].Entities) != 2 || messages[0].Entities[0].Type != markdown.Bold ||
		messages[0].Entities[0].Offset != 6 || messages[0].Entities[0].Length != 1 ||
		messages[0].Entities[1].Type != markdown.Code || messages[0].Entities[1].Offset != 12 ||
		messages[0].Entities[1].Length != 8 {
		t.Fatalf("entities = %#v", messages[0].Entities)
	}
	assertTelegramMessageBounds(t, messages)
}

func TestFormatTelegramReplyDoesNotNormalizeAcrossEntityBoundaries(t *testing.T) {
	messages := formatTelegramReply("&am`p;` &am**p;**")
	if len(messages) != 1 || messages[0].Text != "&amp; &amp;" {
		t.Fatalf("messages = %#v", messages)
	}
	if len(messages[0].Entities) != 2 || messages[0].Entities[0].Type != markdown.Code ||
		messages[0].Entities[0].Offset != 3 || messages[0].Entities[0].Length != 2 ||
		messages[0].Entities[1].Type != markdown.Bold || messages[0].Entities[1].Offset != 9 ||
		messages[0].Entities[1].Length != 2 {
		t.Fatalf("entities = %#v", messages[0].Entities)
	}
}

func TestFormatTelegramReplyRecognizesOnlyCompleteCharacterReferences(t *testing.T) {
	messages := formatTelegramReply("& 中文 &amp; &bogus; &amp; &#1;")
	if len(messages) != 1 || messages[0].Text != "& 中文 & &bogus; & " {
		t.Fatalf("messages = %#v", messages)
	}
}

func TestTelegramEntitiesFilterUnsupportedLinks(t *testing.T) {
	messages := formatTelegramReply(`[anchor](#section) [relative](docs/readme) [web](https://example.com/?a=1&amp;b=2)`)
	if len(messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(messages))
	}
	entities := telegramEntities(messages[0].Entities)
	if len(entities) != 1 || entities[0].URL != "https://example.com/?a=1&b=2" {
		t.Fatalf("entities = %#v", entities)
	}

	entities = telegramEntities([]markdown.Entity{
		{Type: markdown.TextLink, Length: 1, URL: "https:foo"},
		{Type: markdown.TextLink, Length: 1, URL: "https:///foo"},
		{Type: markdown.TextLink, Length: 1, URL: "http://localhost:3000"},
		{Type: markdown.TextLink, Length: 1, URL: "https://example.com:99999"},
		{Type: markdown.TextLink, Length: 1, URL: "https://example.com/path#section"},
		{Type: markdown.TextLink, Length: 1, URL: "tg://user?id=42"},
	})
	if len(entities) != 2 || entities[0].URL != "https://example.com/path#section" ||
		entities[1].URL != "tg://user?id=42" {
		t.Fatalf("validated entities = %#v", entities)
	}
}

func TestSplitTelegramMessageDoesNotSplitSurrogatePair(t *testing.T) {
	messages := splitTelegramMessage(markdown.Message{
		Text: strings.Repeat("a", maxMessageUTF16Units-1) + "😀b",
		Entities: []markdown.Entity{{
			Type: markdown.Bold, Offset: maxMessageUTF16Units - 1, Length: 3,
		}},
	}, maxMessageUTF16Units)
	if len(messages) != 2 {
		t.Fatalf("messages = %d, want 2", len(messages))
	}
	if got := markdown.UTF16Len(messages[0].Text); got != maxMessageUTF16Units-1 {
		t.Fatalf("first message UTF-16 units = %d", got)
	}
	if messages[1].Text != "😀b" {
		t.Fatalf("second message = %q", messages[1].Text)
	}
	if len(messages[1].Entities) != 1 || messages[1].Entities[0].Type != markdown.Bold ||
		messages[1].Entities[0].Offset != 0 || messages[1].Entities[0].Length != 3 {
		t.Fatalf("second message entities = %#v", messages[1].Entities)
	}
	assertTelegramMessageBounds(t, messages)
}

func TestSplitTelegramMessageClipsSpanningEntity(t *testing.T) {
	text := strings.Repeat("a", maxMessageUTF16Units+10)
	messages := splitTelegramMessage(markdown.Message{
		Text: text,
		Entities: []markdown.Entity{{
			Type: markdown.Bold, Length: maxMessageUTF16Units + 10,
		}},
	}, maxMessageUTF16Units)

	if len(messages) != 2 {
		t.Fatalf("messages = %d, want 2", len(messages))
	}
	if len(messages[0].Entities) != 1 || messages[0].Entities[0].Length != maxMessageUTF16Units {
		t.Fatalf("first entities = %#v", messages[0].Entities)
	}
	if len(messages[1].Entities) != 1 || messages[1].Entities[0].Offset != 0 ||
		messages[1].Entities[0].Length != 10 {
		t.Fatalf("second entities = %#v", messages[1].Entities)
	}
	if messages[0].Text+messages[1].Text != text {
		t.Fatal("split messages did not preserve text")
	}
	assertTelegramMessageBounds(t, messages)
}

func TestSplitTelegramMessagePrefersNewline(t *testing.T) {
	messages := splitTelegramMessage(markdown.Message{Text: "12345\n67890"}, 8)
	if len(messages) != 2 || messages[0].Text != "12345\n" || messages[1].Text != "67890" {
		t.Fatalf("messages = %#v", messages)
	}
}

func assertTelegramMessageBounds(t *testing.T, messages []markdown.Message) {
	t.Helper()
	for index, message := range messages {
		length := markdown.UTF16Len(message.Text)
		if length > maxMessageUTF16Units {
			t.Fatalf("message %d has %d UTF-16 units", index, length)
		}
		for _, entity := range message.Entities {
			if entity.Offset < 0 || entity.Length <= 0 || entity.Offset+entity.Length > length {
				t.Fatalf("message %d has invalid entity %#v for length %d", index, entity, length)
			}
		}
	}
}
