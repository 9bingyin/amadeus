package telegram

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/go-telegram/bot/models"
)

const replyPreviewLimit = 500

func formatInboundEnvelope(message *models.Message, mediaLine string) string {
	header := formatEnvelopeHeader(message)
	body := inboundBody(message)
	if body == "" {
		body = mediaLine
	} else if mediaLine != "" {
		body = body + "\n" + mediaLine
	}
	var extras []string
	if reply := formatReplyLine(message); reply != "" {
		extras = append(extras, reply)
	}
	if forward := formatForwardLine(message.ForwardOrigin); forward != "" {
		extras = append(extras, forward)
	}
	if len(extras) == 0 {
		if body == "" {
			return ""
		}
		return header + " " + body
	}
	parts := append([]string{header}, extras...)
	if body != "" {
		parts = append(parts, body)
	}
	return strings.Join(parts, "\n")
}

func formatEnvelopeHeader(message *models.Message) string {
	return "[Telegram #" + strconv.Itoa(message.ID) + " " + senderLabel(message.From) + " " + formatEnvelopeTime(message.Date) + "]"
}

func formatEnvelopeTime(unix int) string {
	return time.Unix(int64(unix), 0).UTC().Format("Mon 2006-01-02 15:04:05Z")
}

func senderLabel(user *models.User) string {
	if user == nil {
		return "id:0"
	}
	var parts []string
	name := sanitizeMeta(strings.TrimSpace(user.FirstName + " " + user.LastName))
	if name != "" {
		parts = append(parts, name)
	}
	if username := sanitizeMeta(user.Username); username != "" {
		parts = append(parts, "(@"+username+")")
	}
	parts = append(parts, "id:"+strconv.FormatInt(user.ID, 10))
	return strings.Join(parts, " ")
}

func chatLabel(chat models.Chat) string {
	name := chat.Title
	if name == "" {
		name = strings.TrimSpace(chat.FirstName + " " + chat.LastName)
	}
	var parts []string
	if cleaned := sanitizeMeta(name); cleaned != "" {
		parts = append(parts, cleaned)
	}
	if username := sanitizeMeta(chat.Username); username != "" {
		parts = append(parts, "(@"+username+")")
	}
	if len(parts) == 0 {
		return "id:" + strconv.FormatInt(chat.ID, 10)
	}
	return strings.Join(parts, " ")
}

func sanitizeMeta(value string) string {
	value = strings.ReplaceAll(value, "[", " ")
	value = strings.ReplaceAll(value, "]", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.Join(strings.Fields(value), " ")
}

func inboundBody(message *models.Message) string {
	if message.Poll != nil {
		return formatPoll(message.Poll)
	}
	if message.Contact != nil {
		return formatContact(message.Contact)
	}
	if message.Dice != nil {
		return formatDice(message.Dice)
	}
	if message.Venue != nil {
		return formatVenue(message.Venue)
	}
	if message.Location != nil {
		return formatLocation(message.Location)
	}
	if message.RichMessage != nil {
		return ""
	}
	if text := strings.TrimSpace(renderTelegramText(message.Text, message.Entities)); text != "" {
		return text
	}
	return strings.TrimSpace(renderTelegramText(message.Caption, message.CaptionEntities))
}

func formatReplyLine(message *models.Message) string {
	preview := ""
	if message.Quote != nil {
		preview = strings.TrimSpace(renderTelegramText(message.Quote.Text, message.Quote.Entities))
	}
	if preview == "" && message.ReplyToMessage != nil {
		preview = replyPreview(message.ReplyToMessage)
	}
	if preview == "" {
		if message.ReplyToMessage != nil {
			return "[Replying to: #" + strconv.Itoa(message.ReplyToMessage.ID) + "]"
		}
		return ""
	}
	preview = truncateRunes(preview, replyPreviewLimit)
	encoded, err := json.Marshal(preview)
	if err != nil {
		if message.ReplyToMessage != nil {
			return "[Replying to: #" + strconv.Itoa(message.ReplyToMessage.ID) + "]"
		}
		return ""
	}
	return "[Replying to: " + string(encoded) + "]"
}

func replyPreview(message *models.Message) string {
	if message.RichMessage != nil {
		text, err := renderRichBlocks(message.RichMessage.Blocks, nil)
		if err == nil && text != "" {
			return strings.Split(text, "\n")[0]
		}
	}
	if text := inboundBody(message); text != "" {
		return strings.Split(text, "\n")[0]
	}
	return mediaKindPlaceholder(message)
}

func formatForwardLine(origin *models.MessageOrigin) string {
	if origin == nil {
		return ""
	}
	label := ""
	unix := 0
	switch origin.Type {
	case models.MessageOriginTypeUser:
		if origin.MessageOriginUser != nil {
			label = senderLabel(&origin.MessageOriginUser.SenderUser)
			unix = origin.MessageOriginUser.Date
		}
	case models.MessageOriginTypeHiddenUser:
		if origin.MessageOriginHiddenUser != nil {
			label = sanitizeMeta(origin.MessageOriginHiddenUser.SenderUserName)
			unix = origin.MessageOriginHiddenUser.Date
		}
	case models.MessageOriginTypeChat:
		if origin.MessageOriginChat != nil {
			label = chatLabel(origin.MessageOriginChat.SenderChat)
			unix = origin.MessageOriginChat.Date
		}
	case models.MessageOriginTypeChannel:
		if origin.MessageOriginChannel != nil {
			label = chatLabel(origin.MessageOriginChannel.Chat)
			unix = origin.MessageOriginChannel.Date
		}
	}
	if label == "" {
		label = "unknown"
	}
	line := "[Forwarded from " + label
	if unix != 0 {
		line += " at " + time.Unix(int64(unix), 0).UTC().Format("2006-01-02 15:04:05Z")
	}
	return line + "]"
}

func formatPoll(poll *models.Poll) string {
	var b strings.Builder
	b.WriteString("[Poll] ")
	b.WriteString(strings.TrimSpace(poll.Question))
	for _, option := range poll.Options {
		b.WriteString("\n- ")
		b.WriteString(strings.Join(strings.Fields(option.Text), " "))
		b.WriteString(" (")
		b.WriteString(strconv.Itoa(option.VoterCount))
		b.WriteString(" votes)")
	}
	pollType := poll.Type
	if pollType == "" {
		pollType = "regular"
	}
	visibility := "public"
	if poll.IsAnonymous {
		visibility = "anonymous"
	}
	selection := "single"
	if poll.AllowsMultipleAnswers {
		selection = "multiple"
	}
	status := "open"
	if poll.IsClosed {
		status = "closed"
	}
	b.WriteString("\nType: ")
	b.WriteString(pollType)
	b.WriteString("\nVisibility: ")
	b.WriteString(visibility)
	b.WriteString("\nSelection: ")
	b.WriteString(selection)
	b.WriteString("\nStatus: ")
	b.WriteString(status)
	return b.String()
}

func formatContact(contact *models.Contact) string {
	name := sanitizeMeta(strings.TrimSpace(contact.FirstName + " " + contact.LastName))
	phone := sanitizeMeta(contact.PhoneNumber)
	switch {
	case name != "" && phone != "":
		return "[Contact " + name + " " + phone + "]"
	case name != "":
		return "[Contact " + name + "]"
	case phone != "":
		return "[Contact " + phone + "]"
	default:
		return "[contact]"
	}
}

func formatDice(dice *models.Dice) string {
	emoji := strings.TrimSpace(dice.Emoji)
	if emoji == "" {
		return "[Dice " + strconv.Itoa(dice.Value) + "]"
	}
	return "[Dice " + emoji + " " + strconv.Itoa(dice.Value) + "]"
}

func formatLocation(location *models.Location) string {
	kind := "Location"
	if location.LivePeriod > 0 {
		kind = "Live location"
	}
	line := fmt.Sprintf("[%s %.6f, %.6f", kind, location.Latitude, location.Longitude)
	if location.HorizontalAccuracy > 0 {
		line += fmt.Sprintf(" ±%dm", int(math.Round(location.HorizontalAccuracy)))
	}
	return line + "]"
}

func formatVenue(venue *models.Venue) string {
	line := formatLocation(&venue.Location)
	line = strings.TrimSuffix(line, "]")
	if title := sanitizeMeta(venue.Title); title != "" {
		line += " " + title
	}
	if address := sanitizeMeta(venue.Address); address != "" {
		line += ", " + address
	}
	return line + "]"
}

func formatSticker(sticker *models.Sticker) string {
	emoji := strings.TrimSpace(sticker.Emoji)
	if emoji == "" {
		return "[sticker]"
	}
	line := "[Sticker " + emoji
	if name := strings.TrimSpace(sticker.SetName); name != "" {
		encoded, err := json.Marshal(name)
		if err == nil {
			line += " from " + string(encoded)
		}
	}
	return line + "]"
}

func mediaKindPlaceholder(message *models.Message) string {
	switch {
	case message.Animation != nil:
		return "[animation]"
	case message.Document != nil:
		return "[document]"
	case len(message.Photo) > 0:
		return "[image]"
	case message.VideoNote != nil:
		return "[video note]"
	case message.Video != nil:
		return "[video]"
	case message.Audio != nil || message.Voice != nil:
		return "[audio]"
	case message.Sticker != nil:
		return formatSticker(message.Sticker)
	default:
		return ""
	}
}

func renderTelegramText(text string, entities []models.MessageEntity) string {
	if text == "" || len(entities) == 0 {
		return text
	}
	units := utf16.Encode([]rune(text))
	type insertion struct {
		at    int
		extra []uint16
	}
	insertions := make([]insertion, 0, len(entities))
	for _, entity := range entities {
		extra := ""
		switch entity.Type {
		case models.MessageEntityTypeTextLink:
			if url := strings.TrimSpace(entity.URL); url != "" {
				extra = " (" + url + ")"
			}
		case models.MessageEntityTypeTextMention:
			if entity.User != nil {
				extra = " (" + senderLabel(entity.User) + ")"
			}
		}
		if extra == "" {
			continue
		}
		at := entity.Offset + entity.Length
		if at < 0 {
			continue
		}
		if at > len(units) {
			at = len(units)
		}
		insertions = append(insertions, insertion{at: at, extra: utf16.Encode([]rune(extra))})
	}
	sort.SliceStable(insertions, func(i, j int) bool {
		return insertions[i].at > insertions[j].at
	})
	for _, item := range insertions {
		units = append(units[:item.at:item.at], append(item.extra, units[item.at:]...)...)
	}
	return string(utf16.Decode(units))
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
