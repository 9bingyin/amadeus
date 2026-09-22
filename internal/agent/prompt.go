package agent

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const systemPromptPreamble = `You are a personal assistant.`

const telegramPrompt = `Each user message starts with [Telegram #<id> <sender> <time>]. The time is UTC. The text after that header is the message.
[Replying to: ...] and [Forwarded from ...] are metadata about that message.
Photos and supported documents also arrive as image or file content. Other attachments appear only as a path, or as a placeholder such as [video], [audio], [sticker], or [document attachment unavailable]. Read a path when you need the file.
Use send_file to send a local file to this chat. kind "photo" sends a compressed image up to 10MB. kind "document" sends the original file up to 50MB.
Write replies with only the formatting Telegram shows: **bold**, *italic*, ~~strikethrough~~, inline code, fenced code blocks, blockquotes, and lists.
Links must be [label](https://example.com) with an absolute http or https URL.
Do not use headings, tables, images, or HTML.
Reply in the user's language.`

const toolsPrompt = `- read: Read file contents
- bash: Execute bash commands (ls, rg, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
- session_search: Search this chat's saved sessions, including the current one. Returns session and message numbers
- session_read: Read one saved session by its number. offset is the message number from session_search`

const hiddenMCPToolsPrompt = `- tools_list: List hidden MCP servers. Omit server to list server names. Pass a server name to list that server's tools and arguments
- tool_call: Call an MCP tool by the name and arguments returned from tools_list`

const scheduleToolPrompt = `- schedule: Create, list, edit, or remove a scheduled task for this chat. create needs a name, when, and script. edit replaces one task's script by name, or by id when more than one task has that name. The script is compiled before it is saved. post inside the script reports to you through the local platform, not the user. list shows this chat's tasks. remove deletes one task by name, or by id when more than one task has that name.`

const scheduleNoticePrompt = `A local message starts with [<identity> <schedule> <time>]. A scheduled task's identity looks like Schedule #<id> <name> and is fixed when the task is created. The schedule is once, every <interval>, or cron <expression>. The time is when it fired, in UTC. The text after the bracket is a report to you, not a message for the user. Reply to the user yourself. Clock times, durations such as 30m, and cron use the timezone in <system>.`

const scheduleSystemPrompt = `You are running a scheduled task. post(text) reports to the main assistant through the local platform. It does not speak to the user. Say what happened. If nothing should be reported, do not call post.`

const scheduleToolsPrompt = `- read: Read file contents
- edit: Make precise file edits with exact text replacement
- write: Create or overwrite files
- post: Report to the main assistant through the local platform. Do not speak to the user. Say what happened.`

const scheduleRulesPrompt = `- Use read to examine files
- Use edit for precise changes (edits[].oldText must match exactly)
- Use write only for new files or complete rewrites
- Keep files in the working directory
- Be concise`

const toolsPromptUsage = `In addition to the tools above, you may have access to other custom tools depending on the project.`

const rulesPrompt = `- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions
- Use write only for new files or complete rewrites
- Be concise in your responses
- Show file paths clearly when working with files`

func BuildSystemPrompt(workspace string, telegram, hiddenMCP bool, skillsPrompt, soul, globalAgents, workspaceAgents string) string {
	var prompt strings.Builder
	if identity := strings.TrimSpace(soul); identity != "" {
		prompt.WriteString(identity)
	} else {
		prompt.WriteString(systemPromptPreamble)
	}
	if telegram {
		writeSection(&prompt, "telegram", telegramPrompt)
	}
	writeSection(&prompt, "schedule", scheduleNoticePrompt)
	writeSection(&prompt, "tools", toolsSection(hiddenMCP))
	writeSection(&prompt, "rules", rulesPrompt)
	if agents := strings.TrimSpace(globalAgents); agents != "" {
		writeSection(&prompt, "agents", agents)
	}
	if agents := strings.TrimSpace(workspaceAgents); agents != "" {
		writeSection(&prompt, "workspace-agents", agents)
	}
	if skills := strings.TrimSpace(skillsPrompt); skills != "" {
		writeSection(&prompt, "skills", skills)
	}
	writeSection(&prompt, "system", describeSystem())
	writeSection(&prompt, "cwd", strings.TrimSpace(workspace))
	return prompt.String()
}

func LoadPromptFiles(home, workspace string) (soul, globalAgents, workspaceAgents string, err error) {
	soul, err = readPromptFile(filepath.Join(home, "SOUL.md"))
	if err != nil {
		return "", "", "", fmt.Errorf("read SOUL.md: %w", err)
	}
	globalPath := filepath.Join(home, "AGENTS.md")
	globalAgents, err = readPromptFile(globalPath)
	if err != nil {
		return "", "", "", fmt.Errorf("read AGENTS.md: %w", err)
	}
	workspacePath := filepath.Join(workspace, "AGENTS.md")
	if filepath.Clean(workspacePath) == filepath.Clean(globalPath) {
		return soul, globalAgents, "", nil
	}
	workspaceAgents, err = readPromptFile(workspacePath)
	if err != nil {
		return "", "", "", fmt.Errorf("read workspace AGENTS.md: %w", err)
	}
	return soul, globalAgents, workspaceAgents, nil
}

func readPromptFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func toolsSection(hiddenMCP bool) string {
	var section strings.Builder
	section.WriteString(toolsPrompt)
	if hiddenMCP {
		section.WriteByte('\n')
		section.WriteString(hiddenMCPToolsPrompt)
	}
	section.WriteByte('\n')
	section.WriteString(scheduleToolPrompt)
	section.WriteString("\n\n")
	section.WriteString(toolsPromptUsage)
	return section.String()
}

func BuildSchedulePrompt(directory string, hiddenMCP bool) string {
	var prompt strings.Builder
	prompt.WriteString(scheduleSystemPrompt)
	var tools strings.Builder
	tools.WriteString(scheduleToolsPrompt)
	if hiddenMCP {
		tools.WriteByte('\n')
		tools.WriteString(hiddenMCPToolsPrompt)
	}
	writeSection(&prompt, "tools", tools.String())
	writeSection(&prompt, "rules", scheduleRulesPrompt)
	writeSection(&prompt, "system", describeTimezone())
	writeSection(&prompt, "cwd", strings.TrimSpace(directory))
	return prompt.String()
}

func writeSection(prompt *strings.Builder, name, body string) {
	prompt.WriteString("\n\n<")
	prompt.WriteString(name)
	prompt.WriteString(">\n")
	prompt.WriteString(body)
	prompt.WriteString("\n</")
	prompt.WriteString(name)
	prompt.WriteString(">")
}

func describeSystem() string {
	pretty := osPrettyName()
	kernel := kernelRelease()
	detail := runtime.GOOS
	if kernel != "" {
		detail += " " + kernel
	}
	detail += " " + runtime.GOARCH
	line := detail
	if pretty != "" {
		line = pretty + "; " + detail
	}
	return line + "\n" + describeTimezone()
}

func describeTimezone() string {
	zone := localZoneName()
	abbrev, offset := time.Now().Zone()
	if zone == "" {
		zone = abbrev
	}
	return formatTimezone(zone, offset)
}

func formatTimezone(zone string, offsetSeconds int) string {
	if zone == "" {
		zone = "Local"
	}
	return "Timezone: " + zone + " (" + formatOffset(offsetSeconds) + ")"
}

func formatOffset(seconds int) string {
	sign := "+"
	if seconds < 0 {
		sign = "-"
		seconds = -seconds
	}
	return fmt.Sprintf("%s%02d:%02d", sign, seconds/3600, (seconds%3600)/60)
}

func localZoneName() string {
	if name := zoneName(os.Getenv("TZ")); name != "" {
		return name
	}
	link, err := os.Readlink("/etc/localtime")
	if err != nil {
		return ""
	}
	return zoneName(link)
}

func zoneName(value string) string {
	value = strings.TrimSpace(strings.TrimPrefix(value, ":"))
	if value == "" || value == "local" {
		return ""
	}
	const marker = "zoneinfo/"
	if index := strings.LastIndex(value, marker); index >= 0 {
		return value[index+len(marker):]
	}
	if strings.HasPrefix(value, "/") {
		return ""
	}
	return value
}

func osPrettyName() string {
	switch runtime.GOOS {
	case "linux":
		data, err := os.ReadFile("/etc/os-release")
		if err != nil {
			return ""
		}
		return osReleasePretty(string(data))
	case "darwin":
		name := commandOutput("sw_vers", "-productName")
		version := commandOutput("sw_vers", "-productVersion")
		return strings.TrimSpace(name + " " + version)
	default:
		return ""
	}
}

func osReleasePretty(data string) string {
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[key] = unquoteOSRelease(value)
	}
	if pretty := values["PRETTY_NAME"]; pretty != "" {
		return pretty
	}
	name := values["NAME"]
	version := values["VERSION"]
	if version == "" {
		version = values["VERSION_ID"]
	}
	return strings.TrimSpace(name + " " + version)
}

func unquoteOSRelease(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '"' || value[len(value)-1] != '"' {
		return value
	}
	value = value[1 : len(value)-1]
	var decoded strings.Builder
	escaped := false
	for _, char := range value {
		if escaped {
			switch char {
			case 'n':
				decoded.WriteByte('\n')
			case 't':
				decoded.WriteByte('\t')
			default:
				decoded.WriteRune(char)
			}
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		decoded.WriteRune(char)
	}
	return decoded.String()
}

func kernelRelease() string {
	var system unix.Utsname
	if err := unix.Uname(&system); err != nil {
		return ""
	}
	return unix.ByteSliceToString(system.Release[:])
}

func commandOutput(name string, args ...string) string {
	output, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return string(bytes.TrimSpace(output))
}
