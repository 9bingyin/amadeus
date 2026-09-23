package conversation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	conversationdb "github.com/9bingyin/amadeus/internal/conversation/db"
)

type ConversationActivity struct {
	ID         string
	Route      Route
	LastUserAt time.Time
	Busy       bool
}

func (s *Store) ListConversationUserActivity(
	ctx context.Context,
	excludedSourceNamespace string,
) ([]ConversationActivity, error) {
	excludedSourceNamespace = strings.TrimSpace(excludedSourceNamespace)
	if excludedSourceNamespace == "" {
		return nil, errors.New("excluded source namespace is required")
	}
	rows, err := conversationdb.New(s.database).ListConversationUserActivity(ctx, sql.NullString{
		String: excludedSourceNamespace, Valid: true,
	})
	if err != nil {
		return nil, fmt.Errorf("list conversation user activity: %w", err)
	}
	activity := make([]ConversationActivity, 0, len(rows))
	for _, row := range rows {
		lastUserAt, err := activityUnixMilli(row.LastUserAtMs)
		if err != nil {
			return nil, err
		}
		activity = append(activity, ConversationActivity{
			ID: row.ID,
			Route: Route{
				Platform: row.Platform, AccountID: row.AccountID,
				ChatID: row.ExternalChatID, ThreadID: row.ExternalThreadID,
			},
			LastUserAt: time.UnixMilli(lastUserAt).UTC(),
			Busy:       row.Busy,
		})
	}
	return activity, nil
}

func activityUnixMilli(value any) (int64, error) {
	switch n := value.(type) {
	case int64:
		return n, nil
	case int:
		return int64(n), nil
	default:
		return 0, fmt.Errorf("conversation activity time has type %T", value)
	}
}
