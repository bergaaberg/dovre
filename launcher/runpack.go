package main

// `dovre run <pack> [checkout] [--set KEY=value …]`: one pack in a throw-away session (#353, #370).
// The session itself is src/run.ts in the core checkout this launcher was built in; this starts it
// with the pinned Node (node.go) in the caller's own folder, so a relative checkout means what the
// caller typed, and hands every argument over unchanged.

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
)

// RunScript: src/run.ts under the first root that has one ("" when none does).
func RunScript(roots ...string) string {
	for _, r := range roots {
		if r == "" {
			continue
		}
		if s := filepath.Join(r, "src", "run.ts"); exists(s) {
			return s
		}
	}
	return ""
}

func runPack(p Paths, args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		return errors.New("usage: dovre run <pack> [checkout] [--set KEY=value …]")
	}
	// install.sh may link the launcher into ~/.local/bin: the core is above the real file too.
	var real string
	if exe, err := os.Executable(); err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			real = filepath.Dir(filepath.Dir(r))
		}
	}
	script := RunScript(p.Root, real)
	if script == "" {
		return errors.New("no Dovre core here (src/run.ts): `dovre run` needs a checkout of dovre with `pnpm install` done")
	}
	h, err := bridgeHome()
	if err != nil {
		return err
	}
	node, err := ensureNode(h.Runtime(), os.Stderr)
	if err != nil {
		return err
	}
	cmd := exec.Command(node, append([]string{script}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Passed on, and this waits for the session to end rather than leave it behind (from a terminal,
	// Ctrl+C reaches both; run.ts ends cleanly either way). A handler, not signal.Ignore: an ignored
	// signal stays ignored in the child. Windows can't send these; its console stops both itself.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigs)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		for s := range sigs {
			_ = cmd.Process.Signal(s)
		}
	}()
	if err := cmd.Wait(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			// run.ts has said why already.
			os.Exit(max(ee.ExitCode(), 1))
		}
		return err
	}
	return nil
}
