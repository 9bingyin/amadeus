package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/felinics/twilight/sdk"
)

const (
	bashDescription = "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds."
	outputIdleGrace = 100 * time.Millisecond
)

type bashInput struct {
	Command string   `json:"command" jsonschema:"Shell command to execute"`
	Timeout *float64 `json:"timeout,omitempty" jsonschema:"Timeout in seconds (optional, no default timeout)"`
}

func (s *toolSet) bashTool() sdk.Tool {
	return sdk.NewTool("bash", bashDescription, func(ctx *sdk.ToolExecContext, input bashInput) (any, error) {
		return s.bash(ctx.Context, input)
	})
}

func (s *toolSet) bash(ctx context.Context, input bashInput) (string, error) {
	if strings.TrimSpace(input.Command) == "" {
		return "", errors.New("command is required")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	runCtx := ctx
	cancel := func() {}
	if input.Timeout != nil {
		if math.IsNaN(*input.Timeout) || math.IsInf(*input.Timeout, 0) || *input.Timeout <= 0 {
			return "", errors.New("timeout must be a finite number greater than zero")
		}
		duration := time.Duration(*input.Timeout * float64(time.Second))
		if duration <= 0 {
			return "", errors.New("timeout is too large")
		}
		runCtx, cancel = context.WithTimeout(ctx, duration)
	}
	defer cancel()

	outputFile, err := os.CreateTemp("", "amadeus-bash-*.log")
	if err != nil {
		return "", fmt.Errorf("create output file: %w", err)
	}
	outputPath := outputFile.Name()
	keepOutputFile := false
	defer func() {
		if !keepOutputFile {
			_ = os.Remove(outputPath)
		}
	}()

	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		_ = outputFile.Close()
		return "", fmt.Errorf("create output pipe: %w", err)
	}

	command := exec.Command(s.shell, "-c", input.Command)
	command.Dir = s.cwd
	command.Env = os.Environ()
	command.Stdout = outputWriter
	command.Stderr = outputWriter
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		_ = outputReader.Close()
		_ = outputWriter.Close()
		_ = outputFile.Close()
		return "", fmt.Errorf("start bash: %w", err)
	}
	if err := outputWriter.Close(); err != nil {
		killProcessGroup(command.Process)
		_ = command.Wait()
		_ = outputReader.Close()
		_ = outputFile.Close()
		return "", fmt.Errorf("close parent output pipe: %w", err)
	}

	activity := make(chan struct{}, 1)
	collectorDone := make(chan error, 1)
	go func() {
		collectorDone <- collectBashOutput(outputReader, outputFile, activity)
	}()
	commandDone := make(chan error, 1)
	go func() { commandDone <- command.Wait() }()

	var (
		waitErr           error
		collectorErr      error
		termination       string
		commandFinished   bool
		collectorFinished bool
	)
	collectorChannel := (<-chan error)(collectorDone)
	for !commandFinished {
		select {
		case waitErr = <-commandDone:
			commandFinished = true
		case collectorErr = <-collectorChannel:
			collectorFinished = true
			collectorChannel = nil
			if collectorErr != nil {
				killProcessGroup(command.Process)
				waitErr = <-commandDone
				commandFinished = true
			}
		case <-runCtx.Done():
			termination = terminationMessage(ctx, runCtx, input.Timeout)
			killProcessGroup(command.Process)
			waitErr = <-commandDone
			commandFinished = true
		}
	}

	if !collectorFinished {
		if termination != "" {
			collectorErr = finishBashOutput(outputReader, collectorDone)
		} else {
			var canceled bool
			collectorErr, canceled = waitForBashOutput(runCtx, outputReader, activity, collectorDone)
			if canceled {
				termination = terminationMessage(ctx, runCtx, input.Timeout)
				killProcessGroup(command.Process)
				collectorErr = finishBashOutput(outputReader, collectorDone)
			}
		}
	}
	if collectorErr != nil {
		_ = outputFile.Close()
		return "", fmt.Errorf("collect bash output: %w", collectorErr)
	}
	if err := outputFile.Close(); err != nil {
		return "", fmt.Errorf("close output file: %w", err)
	}

	output, truncated, err := readBashOutput(outputPath)
	if err != nil {
		return "", err
	}
	if truncated {
		keepOutputFile = true
		output += fmt.Sprintf("\n\n[Output truncated. Full output: %s]", outputPath)
	}
	if output == "" {
		output = "(no output)"
	}

	if termination != "" {
		return "", fmt.Errorf("%s\n\n%s", output, termination)
	}
	if waitErr != nil {
		return "", fmt.Errorf("%s\n\nCommand exited with code %d", output, exitCode(waitErr))
	}
	return output, nil
}

func collectBashOutput(reader *os.File, output *os.File, activity chan<- struct{}) error {
	defer func() { _ = reader.Close() }()
	buffer := make([]byte, 32*1024)
	for {
		readBytes, readErr := reader.Read(buffer)
		if readBytes > 0 {
			if _, err := output.Write(buffer[:readBytes]); err != nil {
				return err
			}
			select {
			case activity <- struct{}{}:
			default:
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, os.ErrClosed) {
				return nil
			}
			return readErr
		}
	}
}

func waitForBashOutput(
	ctx context.Context,
	reader *os.File,
	activity <-chan struct{},
	done <-chan error,
) (error, bool) {
	timer := time.NewTimer(outputIdleGrace)
	defer timer.Stop()
	for {
		select {
		case err := <-done:
			return err, false
		case <-activity:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(outputIdleGrace)
		case <-timer.C:
			_ = reader.Close()
			return <-done, false
		case <-ctx.Done():
			return nil, true
		}
	}
}

func finishBashOutput(reader *os.File, done <-chan error) error {
	timer := time.NewTimer(outputIdleGrace)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		_ = reader.Close()
		return <-done
	}
}

func terminationMessage(parent, runCtx context.Context, timeout *float64) string {
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) && parent.Err() == nil && timeout != nil {
		return fmt.Sprintf("Command timed out after %g seconds", *timeout)
	}
	return "Command aborted"
}

func killProcessGroup(process *os.Process) {
	if process == nil {
		return
	}
	if err := syscall.Kill(-process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		_ = process.Kill()
	}
}

func exitCode(err error) int {
	exitErr, ok := errors.AsType[*exec.ExitError](err)
	if !ok {
		return -1
	}
	if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal())
	}
	return exitErr.ExitCode()
}

func readBashOutput(path string) (string, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", false, fmt.Errorf("open bash output: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return "", false, fmt.Errorf("stat bash output: %w", err)
	}

	start := max(int64(0), info.Size()-maxOutputBytes)
	startsAtLineBoundary := start == 0
	if start > 0 {
		var previous [1]byte
		if _, err := file.ReadAt(previous[:], start-1); err != nil {
			_ = file.Close()
			return "", false, fmt.Errorf("read bash output boundary: %w", err)
		}
		startsAtLineBoundary = previous[0] == '\n'
	}
	length := info.Size() - start
	data, readErr := io.ReadAll(io.NewSectionReader(file, start, length))
	closeErr := file.Close()
	if readErr != nil {
		return "", false, fmt.Errorf("read bash output: %w", readErr)
	}
	if closeErr != nil {
		return "", false, fmt.Errorf("close bash output: %w", closeErr)
	}

	truncated := start > 0
	if start > 0 && !startsAtLineBoundary {
		fileStart := bytes.IndexByte(data, '\n')
		if fileStart >= 0 && fileStart < len(data)-1 {
			data = data[fileStart+1:]
		} else {
			for len(data) > 0 && !utf8.RuneStart(data[0]) {
				data = data[1:]
			}
		}
	}
	raw := string(data)
	text := strings.ToValidUTF8(raw, "�")
	if text != raw {
		truncated = true
	}
	if len(text) > maxOutputBytes {
		text = trimUTF8Tail(text, maxOutputBytes)
		truncated = true
	}

	hasTrailingNewline := strings.HasSuffix(text, "\n")
	text = strings.TrimSuffix(text, "\n")
	lines := strings.Split(text, "\n")
	if len(lines) > maxOutputLines {
		lines = lines[len(lines)-maxOutputLines:]
		truncated = true
	}
	text = strings.Join(lines, "\n")
	if hasTrailingNewline {
		text += "\n"
	}
	return text, truncated, nil
}

func trimUTF8Tail(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	start := len(text) - limit
	for start < len(text) && !utf8.RuneStart(text[start]) {
		start++
	}
	return text[start:]
}
