package instance

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

var ErrAlreadyRunning = errors.New("amadeus is already running")

type Lock struct {
	file *os.File
}

func Acquire(directory string) (*Lock, error) {
	if directory == "" {
		return nil, errors.New("amadeus home is required")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create amadeus home: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(directory, "amadeus.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open amadeus lock: %w", err)
	}
	if err := os.Chmod(file.Name(), 0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("secure amadeus lock: %w", err)
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		pid := readLockPID(file)
		_ = file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			if pid > 0 {
				return nil, fmt.Errorf("%w (pid %d)", ErrAlreadyRunning, pid)
			}
			return nil, ErrAlreadyRunning
		}
		return nil, fmt.Errorf("lock amadeus home: %w", err)
	}
	if err := writeLockPID(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &Lock{file: file}, nil
}

func (l *Lock) Release() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	if err != nil {
		return fmt.Errorf("release amadeus lock: %w", err)
	}
	return nil
}

func writeLockPID(file *os.File) error {
	if err := file.Truncate(0); err != nil {
		return fmt.Errorf("record amadeus lock owner: %w", err)
	}
	if _, err := file.Seek(0, 0); err != nil {
		return fmt.Errorf("record amadeus lock owner: %w", err)
	}
	if _, err := fmt.Fprintf(file, "%d\n", os.Getpid()); err != nil {
		return fmt.Errorf("record amadeus lock owner: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("record amadeus lock owner: %w", err)
	}
	return nil
}

func readLockPID(file *os.File) int {
	if _, err := file.Seek(0, 0); err != nil {
		return 0
	}
	content, err := os.ReadFile(file.Name())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(content)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}
