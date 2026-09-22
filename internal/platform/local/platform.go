package local

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/gateway"
)

const SourceNamespace = "local"

type Route struct {
	Platform  string
	AccountID string
	ChatID    string
	ThreadID  string
}

type Message struct {
	Route    Route
	Identity string
	Detail   string
	Text     string
	EventID  string
}

type Platform struct {
	submit gateway.Submitter
}

func New(submit gateway.Submitter) (*Platform, error) {
	if submit == nil {
		return nil, errors.New("message submitter is required")
	}
	return &Platform{submit: submit}, nil
}

func (p *Platform) Post(ctx context.Context, message Message) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	identity := sanitize(message.Identity)
	if identity == "" {
		return errors.New("identity is required")
	}
	text := strings.TrimSpace(message.Text)
	if text == "" {
		return errors.New("message text is required")
	}
	route := message.Route
	if strings.TrimSpace(route.Platform) == "" || strings.TrimSpace(route.ChatID) == "" {
		return errors.New("main platform route is required")
	}
	eventID := strings.TrimSpace(message.EventID)
	if eventID == "" {
		return errors.New("event id is required")
	}
	_, err := p.submit.Submit(ctx, agent.Message{
		Platform:        route.Platform,
		AccountID:       route.AccountID,
		ConversationID:  route.ChatID,
		ThreadID:        route.ThreadID,
		SenderID:        identity,
		SourceNamespace: SourceNamespace,
		SourceEventID:   eventID,
		Text:            format(identity, sanitize(message.Detail), time.Now(), text),
	})
	if err != nil {
		return fmt.Errorf("post local message: %w", err)
	}
	return nil
}

func format(identity, detail string, at time.Time, body string) string {
	header := fmt.Sprintf("[%s %s %s]", identity, detail, at.UTC().Format("Mon 2006-01-02 15:04:05Z"))
	return header + "\n" + body
}

func sanitize(value string) string {
	value = strings.NewReplacer("[", " ", "]", " ", "\r", " ", "\n", " ").Replace(value)
	return strings.Join(strings.Fields(value), " ")
}
