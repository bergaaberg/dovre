//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

const stillActive = 259

// alive: a process with this id is running and hasn't exited.
func alive(pid int) bool {
	h, err := syscall.OpenProcess(syscall.PROCESS_QUERY_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	return syscall.GetExitCodeProcess(h, &code) == nil && code == stillActive
}

// stopChild: Windows has no SIGTERM to send; the bundle's turns run under the agent host, which outlives it.
func stopChild(cmd *exec.Cmd) { _ = cmd.Process.Kill() }

// stopBridge ends a running `dovre bridge run` and the bundle under it.
func stopBridge(pid int) {
	c := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	hideChild(c)
	_ = c.Run()
}
