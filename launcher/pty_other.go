//go:build !windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

type winsize struct {
	Row    uint16
	Col    uint16
	Xpixel uint16
	Ypixel uint16
}

type posixPTY struct {
	master *os.File
	cmd    *exec.Cmd
	once   sync.Once
}

func openPTS(master *os.File) (*os.File, error) {
	fd := master.Fd()
	switch runtime.GOOS {
	case "darwin":
		const (
			tiocptygrant = 0x20007454
			tiocptyunlk  = 0x20007452
			tiocptygname = 0x40807453
		)
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, tiocptygrant, 0); errno != 0 {
			return nil, fmt.Errorf("TIOCPTYGRANT: %v", errno)
		}
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, tiocptyunlk, 0); errno != 0 {
			return nil, fmt.Errorf("TIOCPTYUNLK: %v", errno)
		}
		var name [128]byte
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, tiocptygname, uintptr(unsafe.Pointer(&name[0]))); errno != 0 {
			return nil, fmt.Errorf("TIOCPTYGNAME: %v", errno)
		}
		end := bytes.IndexByte(name[:], 0)
		if end < 0 {
			end = len(name)
		}
		return os.OpenFile(string(name[:end]), os.O_RDWR|syscall.O_NOCTTY, 0)
	case "linux":
		const (
			tiocsptlck = 0x40045431
			tiocgptn   = 0x80045430
		)
		var unlock int32
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, tiocsptlck, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
			return nil, fmt.Errorf("TIOCSPTLCK: %v", errno)
		}
		var ptn uint32
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, tiocgptn, uintptr(unsafe.Pointer(&ptn))); errno != 0 {
			return nil, fmt.Errorf("TIOCGPTN: %v", errno)
		}
		return os.OpenFile(fmt.Sprintf("/dev/pts/%d", ptn), os.O_RDWR|syscall.O_NOCTTY, 0)
	default:
		return nil, fmt.Errorf("unsupported POSIX platform: %s", runtime.GOOS)
	}
}

func setWinsize(fd uintptr, cols, rows int) error {
	ws := winsize{Row: uint16(rows), Col: uint16(cols)}
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws))); errno != 0 {
		return errno
	}
	return nil
}

// StartConsole runs argv in a POSIX pseudo-terminal of cols × rows, in cwd.
func StartConsole(argv []string, cwd string, cols, rows int) (Console, error) {
	if len(argv) == 0 {
		return nil, errors.New("missing program")
	}
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, err
	}
	slave, err := openPTS(master)
	if err != nil {
		_ = master.Close()
		return nil, err
	}
	_ = setWinsize(master.Fd(), cols, rows)

	cmd := exec.Command(argv[0], argv[1:]...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
	}
	if err := cmd.Start(); err != nil {
		_ = slave.Close()
		_ = master.Close()
		return nil, fmt.Errorf("couldn't start %s: %v", argv[0], err)
	}
	// The child holds the slave descriptor now; close our copy so EOF reaches master when the child exits.
	_ = slave.Close()
	return &posixPTY{master: master, cmd: cmd}, nil
}

func (p *posixPTY) Read(b []byte) (int, error)  { return p.master.Read(b) }
func (p *posixPTY) Write(b []byte) (int, error) { return p.master.Write(b) }
func (p *posixPTY) Resize(cols, rows int) error { return setWinsize(p.master.Fd(), cols, rows) }

func (p *posixPTY) Wait() int {
	err := p.cmd.Wait()
	p.close()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

func (p *posixPTY) Kill() {
	if p.cmd.Process != nil && p.cmd.Process.Pid > 0 {
		// Negative PID kills the entire process group started by Setsid.
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		_ = p.cmd.Process.Kill()
	}
	p.close()
}

func (p *posixPTY) close() {
	p.once.Do(func() {
		_ = p.master.Close()
	})
}
