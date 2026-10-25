//go:build windows

package main

// The Docker pipe (docker.go), straight from kernel32 and advapi32: a named pipe with this user's
// SID as its only reader and writer, each connection relayed into the distro, and the process
// that keeps the distro up while the engine is on.

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

var (
	advapi32                = syscall.NewLazyDLL("advapi32.dll")
	procConvertStringSDToSD = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procCreateNamedPipeW    = kernel32.NewProc("CreateNamedPipeW")
	procConnectNamedPipe    = kernel32.NewProc("ConnectNamedPipe")
	procCreateEventW        = kernel32.NewProc("CreateEventW")
	procGetOverlappedResult = kernel32.NewProc("GetOverlappedResult")
	procFlushFileBuffers    = kernel32.NewProc("FlushFileBuffers")
	procDisconnectNamedPipe = kernel32.NewProc("DisconnectNamedPipe")
	procWaitNamedPipeW      = kernel32.NewProc("WaitNamedPipeW")
)

const (
	pipeAccessDuplex        = 0x3
	fileFlagFirstPipeInst   = 0x00080000
	fileFlagOverlapped      = 0x40000000
	pipeRejectRemoteClients = 0x8
	pipeUnlimitedInstances  = 255
	errorPipeConnected      = 535
	errorIOPending          = 997
	errorSemTimeout         = 121
	errorFileNotFound       = 2
	sddlRevision1           = 1
)

func pipePath(name string) string { return `\\.\pipe\` + name }

// pipeServed: something already serves this pipe (Docker Desktop on docker_engine).
func pipeServed(name string) bool {
	p, _ := syscall.UTF16PtrFromString(pipePath(name))
	r, _, err := procWaitNamedPipeW.Call(uintptr(unsafe.Pointer(p)), 1)
	// Busy (every instance taken) still means served; only "no such pipe" doesn't.
	return r != 0 || err != syscall.Errno(errorFileNotFound)
}

func userSID() (string, error) {
	t, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer t.Close()
	u, err := t.GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String()
}

func pipeSecurity() (*syscall.SecurityAttributes, error) {
	sid, err := userSID()
	if err != nil {
		return nil, err
	}
	s, _ := syscall.UTF16PtrFromString(PipeSDDL(sid))
	var sd uintptr
	if r, _, err := procConvertStringSDToSD.Call(uintptr(unsafe.Pointer(s)), sddlRevision1, uintptr(unsafe.Pointer(&sd)), 0); r == 0 {
		return nil, err
	}
	sa := &syscall.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	return sa, nil
}

func newInstance(name string, sa *syscall.SecurityAttributes, first bool) (syscall.Handle, error) {
	p, _ := syscall.UTF16PtrFromString(pipePath(name))
	mode := uint32(pipeAccessDuplex | fileFlagOverlapped)
	if first {
		// Fails if someone else made this pipe first: we never share a name with a squatter.
		mode |= fileFlagFirstPipeInst
	}
	h, _, err := procCreateNamedPipeW.Call(uintptr(unsafe.Pointer(p)), uintptr(mode), pipeRejectRemoteClients,
		pipeUnlimitedInstances, 64<<10, 64<<10, 0, uintptr(unsafe.Pointer(sa)))
	if syscall.Handle(h) == syscall.InvalidHandle {
		return syscall.InvalidHandle, err
	}
	return syscall.Handle(h), nil
}

// connect waits for a client on an overlapped instance.
func connect(h syscall.Handle) error {
	ev, _, err := procCreateEventW.Call(0, 1, 0, 0)
	if ev == 0 {
		return err
	}
	defer syscall.CloseHandle(syscall.Handle(ev))
	var ov syscall.Overlapped
	ov.HEvent = syscall.Handle(ev)
	r, _, err := procConnectNamedPipe.Call(uintptr(h), uintptr(unsafe.Pointer(&ov)))
	if r != 0 || err == syscall.Errno(errorPipeConnected) {
		return nil
	}
	if err != syscall.Errno(errorIOPending) {
		return err
	}
	var n uint32
	if r, _, err := procGetOverlappedResult.Call(uintptr(h), uintptr(unsafe.Pointer(&ov)), uintptr(unsafe.Pointer(&n)), 1); r == 0 {
		return err
	}
	return nil
}

// ServeDocker serves the engine's pipe until the supervisor ends. Returns at once when there's
// no distro to serve.
func ServeDocker(p Paths) {
	if !dockerDistroExists() {
		return
	}
	name := PipeName(pipeServed(desktopPipe))
	sa, err := pipeSecurity()
	if err != nil {
		note(p, "docker: no pipe: "+err.Error())
		return
	}
	first := true
	h, err := newInstance(name, sa, first)
	if err != nil {
		note(p, "docker: couldn't make "+pipePath(name)+": "+err.Error())
		return
	}
	_ = os.WriteFile(p.File("docker-pipe"), []byte(pipePath(name)), 0o644)
	note(p, "docker: serving "+pipePath(name))
	go keepEngine(p)
	for {
		if err := connect(h); err != nil {
			_ = syscall.CloseHandle(h)
		} else {
			go relayOne(p, h)
		}
		for {
			if h, err = newInstance(name, sa, false); err == nil {
				break
			}
			time.Sleep(time.Second)
		}
	}
}

func engineOn(p Paths) bool { return !exists(p.File("docker-off")) }

// relayOne carries one connection into the distro and back.
func relayOne(p Paths, h syscall.Handle) {
	conn := os.NewFile(uintptr(h), "docker-pipe")
	defer func() {
		procFlushFileBuffers.Call(uintptr(h))
		procDisconnectNamedPipe.Call(uintptr(h))
		_ = conn.Close()
	}()
	if !engineOn(p) {
		return
	}
	cmd := exec.Command("wsl.exe", relayArgs()...)
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
	hideChild(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		return
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		return
	}
	go func() {
		_, _ = io.Copy(in, conn)
		_ = in.Close() // socat ends shortly after its input does
	}()
	_, _ = io.Copy(conn, out)
	_ = cmd.Wait()
}

// keepEngine keeps one process attached to the distro while the engine is on.
func keepEngine(p Paths) {
	var keep *exec.Cmd
	var ended chan struct{}
	for {
		on := engineOn(p)
		running := keep != nil
		if running {
			select {
			case <-ended:
				keep, running = nil, false
			default:
			}
		}
		if on && !running {
			cmd := exec.Command("wsl.exe", keepArgs()...)
			cmd.Env = append(os.Environ(), "WSL_UTF8=1")
			hideChild(cmd)
			if cmd.Start() == nil {
				keep, ended = cmd, make(chan struct{})
				go func(c *exec.Cmd, done chan struct{}) { _ = c.Wait(); close(done) }(cmd, ended)
			}
		} else if !on && running {
			_ = keep.Process.Kill()
			keep = nil
		}
		time.Sleep(2 * time.Second)
	}
}

func dockerDistroExists() bool {
	cmd := exec.Command("wsl.exe", "--list", "--quiet")
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
	hideChild(cmd)
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return HasDistro(out, DockerDistro)
}

// dockerPipe: `dovre docker-pipe`, the pipe on its own (for `pnpm dev`, with no supervisor).
func dockerPipe(p Paths) error {
	if !dockerDistroExists() {
		return errors.New("no " + DockerDistro + " distro: run scripts/docker.ps1 first")
	}
	ServeDocker(p)
	return errors.New("the docker pipe stopped")
}
