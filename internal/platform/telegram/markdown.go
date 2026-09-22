package telegram

import (
	"html"
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	markdown "github.com/eekstunt/telegramify-markdown-go"
	"github.com/go-telegram/bot/models"
)

const maxMessageUTF16Units = 4096

func formatTelegramReply(source string) []markdown.Message {
	message := markdown.Convert(source, markdown.WithHeadingSymbols([6]string{}))
	message = normalizeMarkdownMessage(message)
	return splitTelegramMessage(message, maxMessageUTF16Units)
}

func normalizeMarkdownMessage(message markdown.Message) markdown.Message {
	text, offsets := normalizeCommonMarkText(message.Text, message.Entities)
	entities := make([]markdown.Entity, 0, len(message.Entities))
	for _, entity := range message.Entities {
		end := entity.Offset + entity.Length
		if entity.Offset < 0 || end > len(offsets)-1 {
			continue
		}
		entity.Offset = offsets[entity.Offset]
		entity.Length = offsets[end] - entity.Offset
		if entity.Length < 1 {
			continue
		}
		if entity.Type == markdown.TextLink {
			entity.URL, _ = normalizeCommonMarkText(entity.URL, nil)
		}
		entities = append(entities, entity)
	}
	return markdown.Message{Text: text, Entities: entities}
}

func normalizeCommonMarkText(text string, entities []markdown.Entity) (string, []int) {
	offsets := make([]int, markdown.UTF16Len(text)+1)
	var result strings.Builder
	result.Grow(len(text))
	oldOffset, newOffset := 0, 0

	for byteOffset := 0; byteOffset < len(text); {
		literal := isCodeOffset(oldOffset, entities)
		if !literal && text[byteOffset] == '\\' && byteOffset+1 < len(text) {
			next, size := utf8.DecodeRuneInString(text[byteOffset+1:])
			consumed := 1 + utf16RuneWidth(next)
			if isASCIIPunctuation(next) && !crossesEntityBoundary(oldOffset, oldOffset+consumed, entities) {
				appendNormalizedText(&result, offsets, string(next), consumed, &oldOffset, &newOffset)
				byteOffset += 1 + size
				continue
			}
		}
		if !literal && text[byteOffset] == '&' {
			if decoded, size := decodeCharacterReference(text[byteOffset:]); size > 0 && !crossesEntityBoundary(oldOffset, oldOffset+size, entities) {
				appendNormalizedText(&result, offsets, decoded, size, &oldOffset, &newOffset)
				byteOffset += size
				continue
			}
		}

		current, size := utf8.DecodeRuneInString(text[byteOffset:])
		appendNormalizedText(
			&result, offsets, text[byteOffset:byteOffset+size], utf16RuneWidth(current), &oldOffset, &newOffset,
		)
		byteOffset += size
	}
	return result.String(), offsets
}

func appendNormalizedText(
	result *strings.Builder,
	offsets []int,
	text string,
	consumed int,
	oldOffset, newOffset *int,
) {
	text = strings.Map(func(current rune) rune {
		if unicode.IsControl(current) && current != '\n' && current != '\t' {
			return -1
		}
		return current
	}, text)
	for index := range consumed {
		offsets[*oldOffset+index] = *newOffset
	}
	result.WriteString(text)
	*oldOffset += consumed
	*newOffset += markdown.UTF16Len(text)
	offsets[*oldOffset] = *newOffset
}

func isCodeOffset(offset int, entities []markdown.Entity) bool {
	for _, entity := range entities {
		if (entity.Type == markdown.Code || entity.Type == markdown.Pre) &&
			offset >= entity.Offset && offset < entity.Offset+entity.Length {
			return true
		}
	}
	return false
}

func crossesEntityBoundary(start, end int, entities []markdown.Entity) bool {
	for _, entity := range entities {
		entityEnd := entity.Offset + entity.Length
		if entity.Offset > start && entity.Offset < end || entityEnd > start && entityEnd < end {
			return true
		}
	}
	return false
}

func decodeCharacterReference(text string) (string, int) {
	length := characterReferenceLength(text)
	if length == 0 {
		return "", 0
	}
	candidate := text[:length]
	decoded := html.UnescapeString(candidate)
	if decoded == candidate {
		return "", 0
	}
	return decoded, length
}

func characterReferenceLength(text string) int {
	if len(text) < 4 || text[0] != '&' {
		return 0
	}
	index, limit := 1, 32
	valid := isASCIIAlphaNumeric
	if text[index] == '#' {
		index++
		limit = 7
		valid = isASCIIDigit
		if index < len(text) && (text[index] == 'x' || text[index] == 'X') {
			index++
			limit = 6
			valid = isASCIIHexDigit
		}
	} else if !isASCIIAlpha(text[index]) {
		return 0
	}

	start := index
	for index < len(text) && index-start < limit && valid(text[index]) {
		index++
	}
	if index == start || index >= len(text) || text[index] != ';' {
		return 0
	}
	return index + 1
}

func isASCIIAlpha(current byte) bool {
	return current >= 'a' && current <= 'z' || current >= 'A' && current <= 'Z'
}

func isASCIIAlphaNumeric(current byte) bool {
	return isASCIIAlpha(current) || isASCIIDigit(current)
}

func isASCIIDigit(current byte) bool {
	return current >= '0' && current <= '9'
}

func isASCIIHexDigit(current byte) bool {
	return isASCIIDigit(current) || current >= 'a' && current <= 'f' || current >= 'A' && current <= 'F'
}

func isASCIIPunctuation(current rune) bool {
	return current >= '!' && current <= '/' ||
		current >= ':' && current <= '@' ||
		current >= '[' && current <= '`' ||
		current >= '{' && current <= '~'
}

func utf16RuneWidth(current rune) int {
	if current > '\uFFFF' {
		return 2
	}
	return 1
}

func splitTelegramMessage(message markdown.Message, limit int) []markdown.Message {
	if message.Text == "" || limit < 2 {
		return nil
	}

	messages := make([]markdown.Message, 0, markdown.UTF16Len(message.Text)/limit+1)
	for markdown.UTF16Len(message.Text) > limit {
		prefix, suffix, splitAt := splitTelegramText(message.Text, limit)
		chunkEntities, remainingEntities := splitTelegramEntities(message.Entities, splitAt)
		messages = append(messages, markdown.Message{Text: prefix, Entities: chunkEntities})
		message = markdown.Message{Text: suffix, Entities: remainingEntities}
	}
	if message.Text != "" {
		messages = append(messages, message)
	}
	return messages
}

func splitTelegramText(text string, limit int) (prefix, suffix string, splitAt int) {
	units := 0
	byteOffset := 0
	for index, current := range text {
		width := 1
		if current > '\uFFFF' {
			width = 2
		}
		if units+width > limit {
			break
		}
		units += width
		byteOffset = index + utf8.RuneLen(current)
	}

	prefix = text[:byteOffset]
	if index := strings.LastIndex(prefix, "\n"); index > 0 {
		byteOffset = index + 1
		units = markdown.UTF16Len(text[:byteOffset])
	} else if index := strings.LastIndexAny(prefix, " \t"); index > 0 {
		byteOffset = index + 1
		units = markdown.UTF16Len(text[:byteOffset])
	}
	return text[:byteOffset], text[byteOffset:], units
}

func splitTelegramEntities(entities []markdown.Entity, splitAt int) (current, remaining []markdown.Entity) {
	for _, entity := range entities {
		end := entity.Offset + entity.Length
		switch {
		case end <= splitAt:
			current = append(current, entity)
		case entity.Offset >= splitAt:
			entity.Offset -= splitAt
			remaining = append(remaining, entity)
		default:
			left := entity
			left.Length = splitAt - entity.Offset
			current = append(current, left)

			right := entity
			right.Offset = 0
			right.Length = end - splitAt
			remaining = append(remaining, right)
		}
	}
	return current, remaining
}

func telegramEntities(entities []markdown.Entity) []models.MessageEntity {
	result := make([]models.MessageEntity, 0, len(entities))
	for _, entity := range entities {
		if entity.Type == markdown.TextLink && !supportedTelegramLink(entity.URL) {
			continue
		}
		result = append(result, models.MessageEntity{
			Type:     models.MessageEntityType(entity.Type),
			Offset:   entity.Offset,
			Length:   entity.Length,
			URL:      entity.URL,
			Language: entity.Language,
		})
	}
	return result
}

func supportedTelegramLink(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		hostname := parsed.Hostname()
		if hostname == "" || (net.ParseIP(hostname) == nil && !strings.Contains(hostname, ".")) {
			return false
		}
		if port := parsed.Port(); port != "" {
			value, err := strconv.Atoi(port)
			if err != nil || value < 1 || value > 65535 {
				return false
			}
		}
		return true
	case "tg":
		return parsed.Host != "" || parsed.Opaque != ""
	default:
		return false
	}
}
