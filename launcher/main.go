// Command dovre starts Dovre if it isn't running and brings its window up.
//
//	dovre [open [path]]  (default) focus the Dovre window, or open one, at once; start the server alongside
//	dovre status         is it running, since when, which version
//	dovre restart        restart the server (the window reconnects by itself)
//	dovre stop           stop the server and its supervisor
//	dovre logs           follow the server log
//	dovre supervise      the supervisor itself (started hidden by open)
//	dovre relay -- cmd   an MCP server between a client that can't ask its user and the real one (relay.go)
//	dovre agent-host     runs one agent turn apart from the server, keeping only what Dovre shows (agenthost.go)
//	dovre pty-host       one terminal (ConPTY) for Dovre's terminal page, over stdio frames (pty.go)
//	dovre docker-pipe    Docker Engine's pipe on its own; the supervisor serves it too (docker.go)
//	dovre bridge …       this machine's agents in hosted Dovre: login, run, install, uninstall, status (bridge.go)
//
// It's also the handler for dovre://open/<path> links. Built twice from this source
// (scripts/install.ps1): bin/dovre.exe for terminals and bin/dovrew.exe, without a console
// window, for the hotkey, the login start and links.
//
// Opening never waits for the server: the window shows a starting page with a progress bar,
// which goes on to the app the moment the server answers (src/pwa.ts). This is Go rather than
// PowerShell because PowerShell takes ~0.5 s just to start on this machine; this takes ~35 ms.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	p, err := paths()
	if err == nil {
		verb, arg := Invocation(os.Args[1:])
		err = run(p, verb, arg)
	}
	if err != nil {
		// dovrew.exe has no console to say it in: the log has it either way.
		if p.Data != "" {
			note(p, "launcher: "+err.Error())
		}
		fmt.Fprintln(os.Stderr, "dovre:", err)
		os.Exit(1)
	}
}

// paths: the repo is the folder above bin/, where the launcher is built.
func paths() (Paths, error) {
	root := os.Getenv("DOVRE_ROOT")
	if root == "" {
		exe, err := os.Executable()
		if err != nil {
			return Paths{}, err
		}
		root = filepath.Dir(filepath.Dir(exe))
	}
	port := 4848
	if v, err := strconv.Atoi(os.Getenv("DOVRE_PORT")); err == nil && v > 0 {
		port = v
	}
	return Paths{Root: root, Data: filepath.Join(root, "data"), Port: port}, nil
}

func run(p Paths, verb, arg string) error {
	switch verb {
	case "open", "boot":
		return open(p, arg)
	case "status":
		return status(p)
	case "restart":
		return restart(p)
	case "stop":
		return stop(p)
	case "logs":
		return logs(p)
	case "supervise":
		return supervise(p)
	case "relay":
		return relay(p, os.Args[2:])
	case "agent-host":
		return agentHost(os.Args[2:])
	case "pty-host":
		return ptyHost(os.Args[2:])
	case "docker-pipe":
		return dockerPipe(p)
	case "bridge":
		return bridge(p, os.Args[2:])
	default:
		fmt.Println("dovre [open [path]|status|restart|stop|logs|bridge]")
		return nil
	}
}

func listening(p Paths) bool {
	_, ok := Listener(p.Port)
	return ok
}

// startServer starts the supervisor (which starts the server) and returns at once.
func startServer(p Paths) error {
	if listening(p) {
		return nil
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	// The console-less build, so no window flashes up.
	if w := filepath.Join(filepath.Dir(self), "dovrew.exe"); exists(w) {
		self = w
	}
	return Detached(self, "supervise")
}

func open(p Paths, path string) error {
	up := listening(p)
	if !up {
		// Left behind by a server that crashed: it would send the starting page on too soon.
		_ = os.Remove(p.UpFile())
		if err := startServer(p); err != nil {
			return err
		}
	}
	// A window already open comes forward (one showing the starting page goes on by itself).
	if path == "/" && FocusWindow() {
		return nil
	}
	// The installed app: its service worker shows the starting page while the server isn't up.
	if path == "/" {
		if lnk := appShortcut(); lnk != "" && ShellOpen(lnk) {
			return nil
		}
	}
	devVars, _ := os.ReadFile(filepath.Join(p.Root, ".dev.vars"))
	kept, _ := os.ReadFile(p.File("launch-token"))
	target := AppURL(p.Base(), LoginToken(devVars, kept), path)
	if !up {
		if exists(p.StartingPage()) {
			target = StartingURL(p.StartingPage(), target)
		} else if err := waitServer(p, 45*time.Second); err != nil {
			return err
		}
	}
	if edge := edgePath(); edge != "" {
		return Detached(edge, "--app="+target)
	}
	if !ShellOpen(target) {
		return errors.New("couldn't open a browser")
	}
	return nil
}

// appShortcut: the Start menu shortcut Edge made when Dovre was installed as an app.
func appShortcut() string {
	dir := filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)
	hit := ""
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || hit != "" {
			return nil
		}
		name := d.Name()
		if d.IsDir() || !strings.HasPrefix(name, "Dovre") || !strings.EqualFold(filepath.Ext(name), ".lnk") {
			return nil
		}
		if b, err := os.ReadFile(path); err == nil && AppID(b) != "" {
			hit = path
			return filepath.SkipAll
		}
		return nil
	})
	return hit
}

func edgePath() string {
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles")} {
		if e := filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`); base != "" && exists(e) {
			return e
		}
	}
	return ""
}

type healthz struct {
	Version   string `json:"version"`
	Pid       int    `json:"pid"`
	StartedAt int64  `json:"startedAt"`
}

func health(p Paths) (*healthz, bool) {
	if !listening(p) {
		return nil, false
	}
	c := http.Client{Timeout: 2 * time.Second}
	res, err := c.Get(p.Base() + "/healthz")
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	var h healthz
	if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&h) != nil {
		return nil, false
	}
	return &h, true
}

func waitServer(p Paths, within time.Duration) error {
	deadline := time.Now().Add(within)
	for {
		if _, ok := health(p); ok {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Dovre didn't start; see %s", p.File("dovre.err.log"))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func status(p Paths) error {
	if h, ok := health(p); ok {
		fmt.Printf("Dovre %s is running (pid %d) since %s at %s\n", h.Version, h.Pid, time.UnixMilli(h.StartedAt).Format("2006-01-02 15:04:05"), p.Base())
	} else if listening(p) {
		fmt.Printf("Dovre is starting at %s\n", p.Base())
	} else {
		fmt.Println("Dovre isn't running. Start it with: dovre")
	}
	return nil
}

func serverPID(p Paths) int {
	b, _ := os.ReadFile(p.File("server.pid"))
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func restart(p Paths) error {
	if pid := serverPID(p); pid > 0 {
		// Not a crash: the supervisor starts it again without a pause.
		_ = os.WriteFile(p.File("restart"), nil, 0o644)
		Kill(pid)
	}
	// The supervisor starts it again; when there's none, start one.
	time.Sleep(300 * time.Millisecond)
	if err := startServer(p); err != nil {
		return err
	}
	if err := waitServer(p, 45*time.Second); err != nil {
		return err
	}
	fmt.Println("Restarted.")
	return nil
}

func stop(p Paths) error {
	if err := os.MkdirAll(p.Data, 0o755); err == nil {
		_ = os.WriteFile(p.File("stop"), nil, 0o644)
	}
	if pid := serverPID(p); pid > 0 {
		Kill(pid)
	}
	// Whatever else holds the port (a server started by hand).
	if pid, ok := Listener(p.Port); ok && pid > 0 {
		Kill(int(pid))
	}
	fmt.Println("Stopped.")
	return nil
}

// logs prints the end of the server log and follows it, across restarts.
func logs(p Paths) error {
	file := p.File("dovre.log")
	var at int64
	if b, err := os.ReadFile(file); err == nil {
		lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
		if len(lines) > 40 {
			lines = lines[len(lines)-40:]
		}
		fmt.Println(strings.Join(lines, "\n"))
		at = int64(len(b))
	}
	for {
		time.Sleep(300 * time.Millisecond)
		f, err := os.Open(file)
		if err != nil {
			continue
		}
		st, _ := f.Stat()
		if st.Size() < at {
			at = 0 // a new run started a new log
		}
		if st.Size() > at {
			_, _ = f.Seek(at, io.SeekStart)
			r := bufio.NewReader(f)
			n, _ := io.Copy(os.Stdout, r)
			at += n
		}
		f.Close()
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
