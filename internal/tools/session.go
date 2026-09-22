package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/felinics/twilight/sdk"
)

const (
	sessionSearchLimit = 20
	snippetRunes       = 180
	sessionSearchText  = `Search this chat's saved sessions by text, including the current session and sessions closed by /new. Matches user and assistant text. Queries shorter than 3 characters use a literal match. Returns session numbers, message numbers, time ranges, roles, and short snippets. Pass the message number to session_read as offset.`
	sessionSearchVec   = `Search this chat's saved sessions by meaning, including the current session and sessions closed by /new. Matches user and assistant text. Returns session numbers, message numbers, time ranges, roles, and short snippets. Pass the message number to session_read as offset.`
	sessionReadText    = `Read user and assistant messages from one session in this chat. session is the number returned by session_search. offset is the 1-based message number to start from. Output is truncated to 2000 messages or 50KB.`
)

type SessionSearcher interface {
	Search(ctx context.Context, conversationID, query string, limit int) ([]string, bool, error)
}

type sessionSearchInput struct {
	Query string `json:"query" jsonschema:"Text to find in this chat's saved sessions"`
}

type sessionReadInput struct {
	Session int  `json:"session" jsonschema:"Session number returned by session_search"`
	Offset  *int `json:"offset,omitempty" jsonschema:"Message number to start reading from (1-indexed)"`
	Limit   *int `json:"limit,omitempty" jsonschema:"Maximum number of messages to return"`
}

type SessionTools struct {
	store    *conversation.Store
	searcher SessionSearcher
}

func NewSessionTools(store *conversation.Store, searcher SessionSearcher) (*SessionTools, error) {
	if store == nil {
		return nil, errors.New("session store is required")
	}
	return &SessionTools{store: store, searcher: searcher}, nil
}

func (s *SessionTools) Tools() []sdk.Tool {
	description := sessionSearchText
	if s.searcher != nil {
		description = sessionSearchVec
	}
	return []sdk.Tool{
		sdk.NewTool("session_search", description, func(ctx *sdk.ToolExecContext, input sessionSearchInput) (any, error) {
			return s.search(ctx, input)
		}),
		sdk.NewTool("session_read", sessionReadText, func(ctx *sdk.ToolExecContext, input sessionReadInput) (any, error) {
			return s.read(ctx, input)
		}),
	}
}

func (s *SessionTools) search(toolContext *sdk.ToolExecContext, input sessionSearchInput) (string, error) {
	ctx, route, err := sessionToolContext(toolContext)
	if err != nil {
		return "", err
	}
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return "", errors.New("query is required")
	}
	if s.searcher == nil {
		matches, more, err := s.store.SearchSessions(ctx, route, query, sessionSearchLimit)
		if err != nil {
			return "", err
		}
		return formatMatches(matches, query, more), nil
	}
	documents, err := s.store.ListSearchDocuments(ctx, route)
	if err != nil {
		return "", err
	}
	if len(documents) == 0 {
		return "no matches", nil
	}
	ids, more, err := s.searcher.Search(ctx, documents[0].ConversationID, query, sessionSearchLimit)
	if err != nil {
		return "", err
	}
	byID := make(map[string]conversation.SearchDocument, len(documents))
	for _, document := range documents {
		byID[document.RecordID] = document
	}
	matches := make([]conversation.SessionMatch, 0, len(ids))
	for _, id := range ids {
		document, ok := byID[id]
		if !ok {
			continue
		}
		matches = append(matches, conversation.SessionMatch{
			Ordinal: document.Ordinal, Message: document.Message, Role: document.Role, Text: document.Body,
			StartedAt: document.StartedAt, EndedAt: document.EndedAt,
		})
	}
	return formatMatches(matches, query, more), nil
}

func (s *SessionTools) read(toolContext *sdk.ToolExecContext, input sessionReadInput) (string, error) {
	ctx, route, err := sessionToolContext(toolContext)
	if err != nil {
		return "", err
	}
	if input.Session < 1 {
		return "", errors.New("session must be at least 1")
	}
	offset := 1
	if input.Offset != nil {
		if *input.Offset < 1 {
			return "", errors.New("offset must be at least 1")
		}
		offset = *input.Offset
	}
	limit := 0
	if input.Limit != nil {
		if *input.Limit < 1 {
			return "", errors.New("limit must be at least 1")
		}
		limit = *input.Limit
	}
	transcript, err := s.store.ReadSession(ctx, route, int64(input.Session))
	if err != nil {
		return "", err
	}
	return formatTranscript(transcript, offset, limit)
}

func sessionToolContext(toolContext *sdk.ToolExecContext) (context.Context, conversation.Route, error) {
	if toolContext == nil || toolContext.Context == nil {
		return nil, conversation.Route{}, errors.New("session tools are only available in a conversation")
	}
	ctx := toolContext.Context
	if err := ctx.Err(); err != nil {
		return nil, conversation.Route{}, err
	}
	run, ok := agent.ToolRunFrom(ctx)
	if !ok || run.Platform == "" || run.AccountID == "" || run.ChatID == "" {
		return nil, conversation.Route{}, errors.New("session tools are only available in a conversation")
	}
	return ctx, conversation.Route{
		Platform: run.Platform, AccountID: run.AccountID, ChatID: run.ChatID, ThreadID: run.ThreadID,
	}, nil
}

func formatMatches(matches []conversation.SessionMatch, query string, more bool) string {
	if len(matches) == 0 {
		return "no matches"
	}
	var builder strings.Builder
	for index, match := range matches {
		if index > 0 {
			builder.WriteString("\n\n")
		}
		fmt.Fprintf(&builder, "session %d · message %d · %s\n%s: %s",
			match.Ordinal, match.Message, formatSpan(match.StartedAt, match.EndedAt), match.Role, snippet(match.Text, query))
	}
	if more {
		builder.WriteString("\n\nmore matches exist")
	}
	return builder.String()
}

func formatTranscript(transcript conversation.SessionTranscript, offset, limit int) (string, error) {
	total := len(transcript.Messages)
	if offset > total && (total != 0 || offset != 1) {
		return "", fmt.Errorf("offset %d is beyond the session (%d messages)", offset, total)
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "session %d · %s", transcript.Ordinal, formatSpan(transcript.StartedAt, transcript.EndedAt))
	if total == 0 {
		return builder.String(), nil
	}
	shown := 0
	size := builder.Len()
	byteLimited := false
	for _, message := range transcript.Messages[offset-1:] {
		if shown >= maxOutputLines || (limit > 0 && shown >= limit) {
			break
		}
		number := offset + shown
		block := fmt.Sprintf("\n\n[%d %s]\n%s", number, message.Role, message.Text)
		if size+len(block) > maxOutputBytes && shown > 0 {
			byteLimited = true
			break
		}
		if size+len(block) > maxOutputBytes {
			room := max(maxOutputBytes-size-len(fmt.Sprintf("\n\n[%d %s]\n", number, message.Role)), 0)
			text := message.Text
			if len(text) > room {
				text = text[:room]
			}
			block = fmt.Sprintf("\n\n[%d %s]\n%s", number, message.Role, text)
			builder.WriteString(block)
			shown++
			byteLimited = true
			break
		}
		builder.WriteString(block)
		size += len(block)
		shown++
	}
	next := offset + shown
	if next <= total {
		note := fmt.Sprintf("\n\n[Showing messages %d-%d of %d. Use offset=%d to continue.]", offset, next-1, total, next)
		if byteLimited {
			note = fmt.Sprintf("\n\n[Showing messages %d-%d of %d (50.0KB limit). Use offset=%d to continue.]", offset, next-1, total, next)
		}
		builder.WriteString(note)
	}
	return builder.String(), nil
}

func formatSpan(start, end time.Time) string {
	left := start.UTC().Format(time.RFC3339)
	if end.IsZero() {
		return left + " to open"
	}
	return left + " to " + end.UTC().Format(time.RFC3339)
}

func snippet(body, query string) string {
	flat := strings.Join(strings.Fields(body), " ")
	runes := []rune(flat)
	if len(runes) <= snippetRunes {
		return flat
	}
	at := indexFold(runes, []rune(strings.Join(strings.Fields(query), " ")))
	start := 0
	if at > 40 {
		start = at - 40
	}
	end := start + snippetRunes
	if end > len(runes) {
		end = len(runes)
		start = max(end-snippetRunes, 0)
	}
	var builder strings.Builder
	if start > 0 {
		builder.WriteString("...")
	}
	builder.WriteString(string(runes[start:end]))
	if end < len(runes) {
		builder.WriteString("...")
	}
	return builder.String()
}

func indexFold(haystack, needle []rune) int {
	if len(needle) == 0 || len(needle) > len(haystack) {
		return -1
	}
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if strings.EqualFold(string(haystack[index:index+len(needle)]), string(needle)) {
			return index
		}
	}
	return -1
}
