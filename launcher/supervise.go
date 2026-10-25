//go:build windows

package main

// The supervisor: keeps Dovre's server running. Started by `dovre open` (and at login) as a
// hidden process. A crash starts it again, soon after a long run and with a growing pause when it
// keeps dying; exit code 75 (Settings → Restart) or a restart note (`dovre restart`) starts it
// again at once; `dovre stop` leaves a stop file and the loop ends.

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

func supervise(p Paths) error {
	if !OnlySupervisor(3 * time.Second) {
		return nil
	}
	if err := os.MkdirAll(p.Data, 0o755); err != nil {
		return err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return fmt.Errorf("node isn't on the PATH: %w", err)
	}
	stop := p.File("stop")
	_ = os.Remove(stop)
	_ = os.WriteFile(p.File("supervisor.pid"), []byte(strconv.Itoa(os.Getpid())), 0o644)
	defer func() {
		_ = os.Remove(p.File("supervisor.pid"))
		_ = os.Remove(p.File("server.pid"))
		_ = os.Remove(stop)
	}()

	// Docker Engine in its WSL distro, on a pipe (docker.go); nothing when there's no distro.
	go ServeDocker(p)

	pause := 2 * time.Second
	for {
		if _, err := os.Stat(stop); err == nil {
			return nil
		}
		// Keep the last run's logs beside the new ones; the last run's "listening" file goes, so a
		// starting page doesn't go on before this one listens.
		for _, name := range []string{"dovre.log", "dovre.err.log"} {
			if _, err := os.Stat(p.File(name)); err == nil {
				_ = os.Rename(p.File(name), p.File(name+".1"))
			}
		}
		_ = os.Remove(p.UpFile())
		out, _ := os.Create(p.File("dovre.log"))
		errs, _ := os.Create(p.File("dovre.err.log"))
		cmd := exec.Command(node, "src/index.ts")
		cmd.Dir = p.Root
		// DOVRE_SUPERVISED: the server may exit 75 to be started again (src/boot.ts).
		cmd.Env = append(os.Environ(), "PORT="+strconv.Itoa(p.Port), "DOVRE_SUPERVISED=1")
		cmd.Stdout, cmd.Stderr = out, errs
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
		started := time.Now()
		code := -1
		if err := cmd.Start(); err != nil {
			note(p, fmt.Sprintf("couldn't start the server: %v", err))
		} else {
			_ = os.WriteFile(p.File("server.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0o644)
			_ = cmd.Wait()
			code = cmd.ProcessState.ExitCode()
		}
		_ = out.Close()
		_ = errs.Close()
		if _, err := os.Stat(stop); err == nil {
			return nil
		}
		// Settings → Restart exits 75; `dovre restart` leaves a note before it ends the server.
		if code == 75 || os.Remove(p.File("restart")) == nil {
			pause = 2 * time.Second
			continue
		}
		pause = NextPause(time.Since(started), pause)
		note(p, fmt.Sprintf("exited %d; again in %s", code, pause))
		time.Sleep(pause)
	}
}
