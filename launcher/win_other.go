//go:build !windows

package main

// Off Windows: enough for the launcher to build, vet and test (and to relay) anywhere. Opening a
// window and supervising the server are Windows-only for now; elsewhere run `pnpm start`.

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// FocusWindow: no window to find off Windows.
func FocusWindow() bool { return false }

// Listener: whether something answers on 127.0.0.1:port (who, Windows only).
func Listener(port int) (uint32, bool) {
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 300*time.Millisecond)
	if err != nil {
		return 0, false
	}
	_ = c.Close()
	return 0, true
}

// ShellOpen opens a file or URL with the desktop's default (xdg-open, or open on a Mac).
func ShellOpen(path string) bool {
	for _, bin := range []string{"xdg-open", "open"} {
		if p, err := exec.LookPath(bin); err == nil {
			return exec.Command(p, path).Start() == nil
		}
	}
	return false
}

// OnlySupervisor: there's no supervisor off Windows.
func OnlySupervisor(time.Duration) bool { return false }

// Detached starts a program that outlives the launcher.
func Detached(bin string, args ...string) error {
	cmd := exec.Command(bin, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Kill ends a process by id; quietly, since it may be gone already.
func Kill(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Kill()
	}
}

func supervise(Paths) error {
	return errors.New("the supervisor is Windows-only for now: run `pnpm start` in the repo instead")
}

func hideChild(cmd *exec.Cmd) {}

// ServeDocker: the Docker pipe is a Windows named pipe (dockerpipe_windows.go).
func ServeDocker(Paths) {}

func dockerPipe(Paths) error { return errors.New("the docker pipe is Windows-only") }
