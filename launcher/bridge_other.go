//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// alive: a process with this id is running (signal 0 checks without sending anything).
func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// stopChild asks the bundle to stop (it ends its turns and closes the socket).
func stopChild(cmd *exec.Cmd) { _ = cmd.Process.Signal(syscall.SIGTERM) }

// stopBridge asks a running `dovre bridge run` to stop; it stops the bundle first.
func stopBridge(pid int) { _ = syscall.Kill(pid, syscall.SIGTERM) }
