package schedule

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/felinics/twilight/sdk"
)

const scheduleToolText = "Create, list, edit, or remove a scheduled task for this chat. A task runs its script on schedule. The script is compiled before it is saved. post reports what happened to the main assistant through the local platform. It does not speak to the user. No post stays silent."

type scheduleInput struct {
	Action string `json:"action" jsonschema:"create, list, edit, or remove"`
	Name   string `json:"name,omitempty" jsonschema:"Task name. Required for create. For edit or remove, matches one task in this chat."`
	ID     int64  `json:"id,omitempty" jsonschema:"Task id from list. Use it to edit or remove a task when more than one has the same name."`
	When   string `json:"when,omitempty" jsonschema:"When to run. A duration such as 30m runs once. An RFC3339 time runs once at that instant. every 30m repeats. A five-field cron expression repeats in the timezone from the system prompt. A clock time without a zone uses that timezone."`
	Script string `json:"script,omitempty" jsonschema:"JavaScript for each run. Required for create and edit. No top-level await. agent(prompt), post(text), read(path), and write(path, text) return immediately. agent may call post. post reports what happened to the main assistant through the local platform and does not speak to the user. read and write use this task's directory. The final agent reply is not delivered."`
}

func (s *Service) Tool() sdk.Tool {
	return sdk.NewTool("schedule", scheduleToolText, func(toolContext *sdk.ToolExecContext, input scheduleInput) (any, error) {
		owner, err := toolRoute(toolContext)
		if err != nil {
			return "", err
		}
		switch strings.TrimSpace(input.Action) {
		case "create":
			return s.create(toolContext.Context, owner, input.Name, input.When, input.Script)
		case "list":
			jobs, err := s.list(toolContext.Context, owner)
			if err != nil {
				return "", err
			}
			return formatJobs(jobs), nil
		case "edit":
			return s.edit(toolContext.Context, owner, input.Name, input.ID, input.Script)
		case "remove":
			return s.remove(toolContext.Context, owner, input.Name, input.ID)
		default:
			return "", errors.New("action must be create, list, edit, or remove")
		}
	})
}

func toolRoute(toolContext *sdk.ToolExecContext) (route, error) {
	if toolContext == nil || toolContext.Context == nil {
		return route{}, errors.New("schedule is only available in a conversation")
	}
	ctx := toolContext.Context
	if err := ctx.Err(); err != nil {
		return route{}, err
	}
	run, ok := agent.ToolRunFrom(ctx)
	if !ok || run.Platform == "" || run.AccountID == "" || run.ChatID == "" {
		return route{}, errors.New("schedule is only available in a conversation")
	}
	return route{Platform: run.Platform, AccountID: run.AccountID, ChatID: run.ChatID, ThreadID: run.ThreadID}, nil
}

func (s *Service) create(ctx context.Context, owner route, name, when, script string) (string, error) {
	name, err := cleanName(name)
	if err != nil {
		return "", err
	}
	if err := checkScript(script); err != nil {
		return "", err
	}
	parsed, err := parseWhen(when, time.Now())
	if err != nil {
		return "", err
	}
	item, err := s.insert(ctx, job{
		Name: name, Kind: parsed.Kind, Spec: parsed.Spec, Next: parsed.Next,
		Platform: owner.Platform, AccountID: owner.AccountID, ChatID: owner.ChatID, ThreadID: owner.ThreadID,
	})
	if err != nil {
		return "", err
	}
	directory := item.directory(s.directory)
	if err := writeScript(directory, script); err != nil {
		if deleteErr := s.delete(ctx, item.ID); deleteErr != nil {
			err = errors.Join(err, deleteErr)
		}
		if removeErr := os.RemoveAll(directory); removeErr != nil {
			err = errors.Join(err, removeErr)
		}
		return "", err
	}
	s.wakeSoon()
	return fmt.Sprintf("created %s %s next %s", item.Identity, parsed.Label, item.Next.UTC().Format(time.RFC3339)), nil
}

func (s *Service) edit(ctx context.Context, owner route, name string, id int64, script string) (string, error) {
	if err := checkScript(script); err != nil {
		return "", err
	}
	item, err := s.find(ctx, owner, name, id)
	if err != nil {
		return "", err
	}
	if item.State == "running" {
		return "", errors.New("task is running")
	}
	if err := writeScript(item.directory(s.directory), script); err != nil {
		return "", err
	}
	return fmt.Sprintf("updated %s", item.Identity), nil
}

func (s *Service) ActiveText(ctx context.Context, platform, accountID, chatID, threadID string) (string, error) {
	jobs, err := s.list(ctx, route{Platform: platform, AccountID: accountID, ChatID: chatID, ThreadID: threadID})
	if err != nil {
		return "", err
	}
	active := make([]job, 0, len(jobs))
	for _, item := range jobs {
		if item.State == "completed" {
			continue
		}
		active = append(active, item)
	}
	return formatActive(active), nil
}

func (s *Service) remove(ctx context.Context, owner route, name string, id int64) (string, error) {
	item, err := s.find(ctx, owner, name, id)
	if err != nil {
		return "", err
	}
	if item.State == "running" {
		return "", errors.New("task is running")
	}
	if err := os.RemoveAll(item.directory(s.directory)); err != nil {
		return "", fmt.Errorf("remove task directory: %w", err)
	}
	if err := s.delete(ctx, item.ID); err != nil {
		return "", err
	}
	return fmt.Sprintf("removed %s", item.Identity), nil
}

func (s *Service) find(ctx context.Context, owner route, name string, id int64) (job, error) {
	if id != 0 {
		return s.jobByID(ctx, owner, id)
	}
	if strings.TrimSpace(name) == "" {
		return job{}, errors.New("name or id is required")
	}
	name, err := cleanName(name)
	if err != nil {
		return job{}, err
	}
	matches, err := s.jobsByName(ctx, owner, name)
	if err != nil {
		return job{}, err
	}
	switch len(matches) {
	case 0:
		return job{}, fmt.Errorf("unknown task %q", name)
	case 1:
		return matches[0], nil
	default:
		return job{}, fmt.Errorf("more than one task is named %q", name)
	}
}

func formatJobs(jobs []job) string {
	if len(jobs) == 0 {
		return "no scheduled tasks"
	}
	var builder strings.Builder
	for index, item := range jobs {
		if index > 0 {
			builder.WriteByte('\n')
		}
		fmt.Fprintf(&builder, "%s · %s · %s", item.Identity, labelFor(item.Kind, item.Spec), item.State)
		if item.State == "scheduled" {
			fmt.Fprintf(&builder, " · %s", item.Next.UTC().Format(time.RFC3339))
		}
		if item.Status == "error" && item.LastError != "" {
			fmt.Fprintf(&builder, " · error: %s", sanitizeMeta(item.LastError))
		}
	}
	return builder.String()
}

func formatActive(jobs []job) string {
	if len(jobs) == 0 {
		return "没有未完成的定时任务。"
	}
	var builder strings.Builder
	for index, item := range jobs {
		if index > 0 {
			builder.WriteByte('\n')
		}
		fmt.Fprintf(&builder, "%s · %s", item.Identity, labelFor(item.Kind, item.Spec))
		if item.State == "running" {
			builder.WriteString(" · 运行中")
		} else {
			fmt.Fprintf(&builder, " · 下次 %s", item.Next.UTC().Format(time.RFC3339))
		}
		if item.Status == "error" && item.LastError != "" {
			fmt.Fprintf(&builder, " · 上次失败：%s", sanitizeMeta(item.LastError))
		}
	}
	return builder.String()
}
