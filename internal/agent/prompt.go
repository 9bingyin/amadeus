package agent

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"golang.org/x/sys/unix"
)

const systemPromptPreamble = `You are a personal assistant.`

const telegramPrompt = `Each user message starts with [Telegram #<id> <sender> <time>]. The text after that header is the message.
[Replying to: ...] and [Forwarded from ...] are metadata about that message.
Photos and supported documents also arrive as image or file content. Other attachments appear only as a path, or as a placeholder such as [video], [audio], [sticker], or [document attachment unavailable]. Read a path when you need the file.
Write replies with only the formatting Telegram shows: **bold**, *italic*, ~~strikethrough~~, inline code, fenced code blocks, blockquotes, and lists.
Links must be [label](https://example.com) with an absolute http or https URL.
Do not use headings, tables, images, or HTML.
Reply in the user's language.`

const toolsPrompt = `- read: Read file contents
- bash: Execute bash commands (ls, rg, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.`

const rulesPrompt = `- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions
- Use write only for new files or complete rewrites
- Be concise in your responses
- Show file paths clearly when working with files`

func BuildSystemPrompt(workspace string, telegram bool, skillsPrompt string) string {
	var prompt strings.Builder
	prompt.WriteString(systemPromptPreamble)
	if telegram {
		writeSection(&prompt, "telegram", telegramPrompt)
	}
	writeSection(&prompt, "tools", toolsPrompt)
	writeSection(&prompt, "rules", rulesPrompt)
	if skills := strings.TrimSpace(skillsPrompt); skills != "" {
		writeSection(&prompt, "skills", skills)
	}
	writeSection(&prompt, "system", describeSystem())
	writeSection(&prompt, "cwd", strings.TrimSpace(workspace))
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
	if pretty == "" {
		return detail
	}
	return pretty + "; " + detail
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
