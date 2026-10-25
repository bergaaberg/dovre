//go:build windows

package main

// Windows calls, straight to the system DLLs (no packages to fetch): finding and focusing the
// Dovre window, who listens on a port, opening a shortcut, a lock so one supervisor runs.

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procEnumWindows         = user32.NewProc("EnumWindows")
	procGetWindowTextW      = user32.NewProc("GetWindowTextW")
	procGetClassNameW       = user32.NewProc("GetClassNameW")
	procIsWindowVisible     = user32.NewProc("IsWindowVisible")
	procIsIconic            = user32.NewProc("IsIconic")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procKeybdEvent          = user32.NewProc("keybd_event")

	shell32           = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteW = shell32.NewProc("ShellExecuteW")

	iphlpapi                = syscall.NewLazyDLL("iphlpapi.dll")
	procGetExtendedTcpTable = iphlpapi.NewProc("GetExtendedTcpTable")

	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutexW = kernel32.NewProc("CreateMutexW")
)

const (
	swRestore             = 9
	vkMenu                = 0x12
	keyeventfKeyup        = 0x2
	afInet                = 2
	tcpTableOwnerPidListn = 3
	errorInsufficientBuf  = 122
	errorAlreadyExists    = 183

	createNoWindow        = 0x08000000
	detachedProcess       = 0x00000008
	createNewProcessGroup = 0x00000200
)

func windowText(h uintptr, proc *syscall.LazyProc) string {
	buf := make([]uint16, 512)
	n, _, _ := proc.Call(h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf[:n])
}

// An app window's title is the page's ("Agents · Dovre"); a browser tab's ends in "- Microsoft Edge".
func isDovreTitle(s string) bool {
	return s == "Dovre" || strings.HasSuffix(s, " Dovre") || strings.HasPrefix(s, "Dovre -")
}

var (
	found     uintptr
	enumFound = syscall.NewCallback(func(h, _ uintptr) uintptr {
		if v, _, _ := procIsWindowVisible.Call(h); v == 0 {
			return 1
		}
		if windowText(h, procGetClassNameW) != "Chrome_WidgetWin_1" {
			return 1
		}
		if isDovreTitle(windowText(h, procGetWindowTextW)) {
			found = h
			return 0
		}
		return 1
	})
)

// FocusWindow brings an open Dovre window to the front; false when there's none.
func FocusWindow() bool {
	found = 0
	procEnumWindows.Call(enumFound, 0)
	h := found
	if h == 0 {
		return false
	}
	if v, _, _ := procIsIconic.Call(h); v != 0 {
		procShowWindow.Call(h, swRestore)
	}
	// Windows only lets the foreground app hand focus on; a tap of Alt counts as our input.
	procKeybdEvent.Call(vkMenu, 0, 0, 0)
	procKeybdEvent.Call(vkMenu, 0, keyeventfKeyup, 0)
	r, _, _ := procSetForegroundWindow.Call(h)
	return r != 0
}

// Listener: the process listening on 127.0.0.1:port, from the system's table (asking the port
// itself takes Windows ~2 s to give up on when nobody listens).
func Listener(port int) (uint32, bool) {
	var size uint32
	procGetExtendedTcpTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, afInet, tcpTableOwnerPidListn, 0)
	for range 3 {
		if size == 0 {
			return 0, false
		}
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, afInet, tcpTableOwnerPidListn, 0)
		if r == 0 {
			return ListenerPID(buf[:size], port)
		}
		if r != errorInsufficientBuf {
			return 0, false
		}
	}
	return 0, false
}

// ShellOpen opens a file the way Explorer would (a shortcut runs what it points at).
func ShellOpen(path string) bool {
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(path)
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
	return r > 32
}

// OnlySupervisor takes a lock for this user's session; false when another supervisor keeps it.
// The lock lasts as long as this process. One that's just been told to stop may still hold it
// for a moment (`dovre stop` then `dovre`), so this waits up to `within` for it to go.
func OnlySupervisor(within time.Duration) bool {
	name, _ := syscall.UTF16PtrFromString(`Local\DovreSupervisor`)
	deadline := time.Now().Add(within)
	for {
		h, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
		if h != 0 && err != syscall.Errno(errorAlreadyExists) {
			return true
		}
		// Our handle would keep the lock alive after its owner goes: let go before trying again.
		if h != 0 {
			_ = syscall.CloseHandle(syscall.Handle(h))
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// Detached starts a program that outlives the launcher, without a console window.
func Detached(bin string, args ...string) error {
	cmd := exec.Command(bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcess | createNewProcessGroup}
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

// hideChild: an agent CLI started by the agent host gets no console window of its own.
func hideChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
