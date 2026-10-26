package main

// `dovre bridge`: this machine's agents in hosted Dovre (dovre-site#9, ARCHITECTURE §6a).
//
//	dovre bridge login <handle>   pair this machine: a code to type at <handle>.dovre.dev/cloud/bridge
//	dovre bridge run              run the bridge here, in front (what the login item runs)
//	dovre bridge install          start it at login (launchd, systemd --user, or the Run key) and now
//	dovre bridge uninstall        stop it and don't start it at login
//	dovre bridge status           paired with what, started at login, running
//
// Pairing is a device-code flow against dovre.dev (like `gh auth login`): the code is typed on
// the cockpit's page while signed in, never put in a link. What it hands back (a refresh token
// and this machine's frame key) is kept in <config>/dovre/bridge.json, owner-only. `run` starts
// the bridge's bundle (src/bridge/main.ts, `pnpm build:bridge`) on a pinned Node (node.go), which
// trades the refresh token for a short-lived JWT on every dial, and starts it again if it stops,
// unless it stopped because the machine was unpaired. The agent host is this binary.

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// version is set at release (-ldflags "-X main.version=…"); a local build says so.
var version = "dev"

const defaultServer = "https://dovre.dev"

// exitUnpaired: the bundle's exit when the machine isn't paired (any more); not started again.
const exitUnpaired = 3

// BridgeHome: where the bridge keeps its sign-in, data, Node and log (DOVRE_BRIDGE_HOME, else
// the user config folder: ~/Library/Application Support/dovre, ~/.config/dovre, %AppData%\dovre).
type BridgeHome struct{ Dir string }

func bridgeHome() (BridgeHome, error) {
	if d := os.Getenv("DOVRE_BRIDGE_HOME"); d != "" {
		return BridgeHome{d}, nil
	}
	d, err := os.UserConfigDir()
	if err != nil {
		return BridgeHome{}, err
	}
	return BridgeHome{filepath.Join(d, "dovre")}, nil
}

func (h BridgeHome) Creds() string   { return filepath.Join(h.Dir, "bridge.json") }
func (h BridgeHome) Data() string    { return filepath.Join(h.Dir, "bridge-data") }
func (h BridgeHome) Runtime() string { return filepath.Join(h.Dir, "runtime") }
func (h BridgeHome) Pid() string     { return filepath.Join(h.Dir, "bridge.pid") }
func (h BridgeHome) Log() string     { return filepath.Join(h.Dir, "bridge.log") }

// Creds: what pairing hands back; read by src/bridge/creds.ts, which writes back each rotated refresh token.
type Creds struct {
	Server       string `json:"server"`
	Handle       string `json:"handle"`
	Machine      string `json:"machine"`
	Name         string `json:"name"`
	Hub          string `json:"hub"`
	FrameKey     string `json:"frame_key"`
	RefreshToken string `json:"refresh_token"`
}

func bridge(p Paths, args []string) error {
	h, err := bridgeHome()
	if err != nil {
		return err
	}
	verb := ""
	if len(args) > 0 {
		verb, args = args[0], args[1:]
	}
	switch verb {
	case "login":
		return bridgeLogin(h, args)
	case "run":
		return bridgeRun(h, p)
	case "install":
		return bridgeInstall(h)
	case "uninstall":
		return bridgeUninstall(h)
	case "status":
		return bridgeStatus(h)
	default:
		fmt.Println("dovre bridge login <handle> | run | install | uninstall | status")
		return nil
	}
}

var handleRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// ServerOK: tokens go only over https (or to this machine, for tests).
func ServerOK(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.Path != "" && u.Path != "/" {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http" && u.Hostname() == "127.0.0.1"
}

func bridgeLogin(h BridgeHome, args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	name := fs.String("name", MachineName(), "this machine's name in Dovre")
	server := fs.String("server", envOr("DOVRE_SERVER", defaultServer), "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) > 0 {
		// Flags after the handle too.
		if err := fs.Parse(rest[1:]); err != nil {
			return err
		}
		rest = append(rest[:1], fs.Args()...)
	}
	if len(rest) != 1 || !handleRe.MatchString(strings.ToLower(rest[0])) {
		return errors.New("usage: dovre bridge login <handle>  (your cockpit is <handle>.dovre.dev)")
	}
	srv := strings.TrimRight(*server, "/")
	if !ServerOK(srv) {
		return fmt.Errorf("%s: the server must be https", srv)
	}
	c, err := Pair(&http.Client{Timeout: 30 * time.Second}, srv, strings.ToLower(rest[0]), *name, os.Stdout, time.Sleep)
	if err != nil {
		return err
	}
	// A bridge running on the old sign-in would write its next refresh token over the new one.
	if pid := readPid(h.Pid()); pid > 0 && alive(pid) {
		stopBridge(pid)
		for i := 0; i < 50 && alive(pid); i++ {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if err := SaveCreds(h.Creds(), c); err != nil {
		return err
	}
	fmt.Printf("Paired %q with %s.\n", c.Name, strings.TrimPrefix(strings.TrimSuffix(c.Hub, "/bridge"), "wss://"))
	if serviceInstalled() {
		_ = serviceRestart(h)
		fmt.Println("The bridge started again with the new sign-in.")
	} else {
		fmt.Println("Start it at login (and now) with: dovre bridge install")
	}
	return nil
}

// MachineName: the hostname, without macOS's .local.
func MachineName() string {
	n, _ := os.Hostname()
	n = strings.TrimSuffix(n, ".local")
	if n == "" {
		n = "this machine"
	}
	return n
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

type deviceStart struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
	Error           string `json:"error"`
}

type tokenReply struct {
	Creds
	Error string `json:"error"`
}

func postJSON(c *http.Client, to string, body any, into any) (int, error) {
	b, _ := json.Marshal(body)
	res, err := c.Post(to, "application/json", bytes.NewReader(b))
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(into)
	return res.StatusCode, nil
}

// Pair runs the device-code flow: a code for the user to type at their cockpit, then polls until
// they have (or it expires, or they said no).
func Pair(c *http.Client, server, handle, name string, out io.Writer, sleep func(time.Duration)) (Creds, error) {
	var d deviceStart
	status, err := postJSON(c, server+"/bridge/device", map[string]string{"handle": handle, "name": name}, &d)
	switch {
	case err != nil:
		return Creds{}, fmt.Errorf("couldn't reach %s: %w", server, err)
	case status == 404:
		return Creds{}, fmt.Errorf("there's no cockpit %s.dovre.dev", handle)
	case status == 429:
		return Creds{}, errors.New("too many pairings waiting for that cockpit: try again in ten minutes")
	case status != 200 || d.DeviceCode == "" || d.UserCode == "":
		return Creds{}, fmt.Errorf("pairing didn't start (%d %s)", status, d.Error)
	}
	fmt.Fprintf(out, "\nOpen %s while signed in, and enter this code:\n\n    %s\n\nWaiting…\n", d.VerificationURI, d.UserCode)
	interval := time.Duration(max(d.Interval, 1)) * time.Second
	deadline := time.Now().Add(time.Duration(max(d.ExpiresIn, 60)) * time.Second)
	for time.Now().Before(deadline) {
		sleep(interval)
		var t tokenReply
		status, err := postJSON(c, server+"/bridge/token", map[string]string{"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": d.DeviceCode}, &t)
		if err != nil {
			continue // the network blinked: ask again
		}
		switch t.Error {
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
			continue
		case "expired_token":
			return Creds{}, errors.New("the code expired: run this again")
		case "access_denied":
			return Creds{}, errors.New("pairing was turned down on the cockpit")
		case "":
		default:
			return Creds{}, fmt.Errorf("pairing failed (%s)", t.Error)
		}
		cr := t.Creds
		cr.Server = server
		if cr.Name == "" {
			cr.Name = name
		}
		if cr.Handle == "" {
			cr.Handle = handle
		}
		if status != 200 || cr.RefreshToken == "" || cr.Machine == "" || len(cr.FrameKey) < 32 || !(strings.HasPrefix(cr.Hub, "wss://") || strings.HasPrefix(cr.Hub, "ws://127.0.0.1")) {
			return Creds{}, fmt.Errorf("pairing came back incomplete (%d)", status)
		}
		return cr, nil
	}
	return Creds{}, errors.New("the code expired: run this again")
}

// SaveCreds writes the file whole and owner-only.
func SaveCreds(file string, c Creds) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	return os.Rename(tmp, file)
}

func loadCreds(file string) (Creds, bool) {
	var c Creds
	b, err := os.ReadFile(file)
	if err != nil || json.Unmarshal(b, &c) != nil || c.RefreshToken == "" || c.Hub == "" {
		return Creds{}, false
	}
	return c, true
}

// findBundle: the bridge's code. Released: bridge/main.mjs beside this binary. In a checkout:
// dist/bridge/main.mjs once built, else src/bridge/main.ts (Node 24 runs it as it is).
func findBundle(p Paths) (string, error) {
	if b := os.Getenv("DOVRE_BRIDGE_BUNDLE"); b != "" {
		return b, nil
	}
	exe, _ := os.Executable()
	for _, b := range []string{
		filepath.Join(filepath.Dir(exe), "bridge", "main.mjs"),
		filepath.Join(p.Root, "dist", "bridge", "main.mjs"),
		filepath.Join(p.Root, "src", "bridge", "main.ts"),
	} {
		if exists(b) {
			return b, nil
		}
	}
	return "", errors.New("the bridge's code isn't here: reinstall Dovre (or `pnpm build:bridge` in a checkout)")
}

// hostExe: the agent host is this binary; on Windows the console build, whose stdio it uses.
func hostExe() string {
	exe, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	if strings.EqualFold(filepath.Base(exe), "dovrew.exe") {
		if c := filepath.Join(filepath.Dir(exe), "dovre.exe"); exists(c) {
			return c
		}
	}
	return exe
}

// AfterExit: whether the bundle is started again after it exited with `code`. A clean stop, a
// setting missing, or the machine unpaired: no, starting it again wouldn't help.
func AfterExit(code int) bool {
	return code != 0 && code != 2 && code != exitUnpaired
}

func bridgeRun(h BridgeHome, p Paths) error {
	if _, ok := loadCreds(h.Creds()); !ok {
		return errors.New("this machine isn't paired: run `dovre bridge login <handle>`")
	}
	if err := os.MkdirAll(h.Data(), 0o700); err != nil {
		return err
	}
	// One bridge a machine: two would keep replacing each other at the hub.
	if pid := readPid(h.Pid()); pid > 0 && pid != os.Getpid() && alive(pid) {
		return fmt.Errorf("the bridge is already running here (pid %d)", pid)
	}
	_ = os.WriteFile(h.Pid(), []byte(strconv.Itoa(os.Getpid())), 0o644)
	defer os.Remove(h.Pid())

	logw := openLog(h.Log())
	defer logw.Close()
	out := io.MultiWriter(os.Stdout, logw)
	say := func(f string, a ...any) {
		fmt.Fprintf(out, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(f, a...))
	}

	node, err := ensureNode(h.Runtime(), out)
	if err != nil {
		return err
	}
	bundle, err := findBundle(p)
	if err != nil {
		return err
	}
	env := append(os.Environ(),
		"DOVRE_BRIDGE_CREDENTIALS="+h.Creds(),
		"DOVRE_BRIDGE_DATA="+h.Data(),
		"DOVRE_HOST_EXE="+hostExe(),
		"DOVRE_VERSION="+version,
	)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigs)
	var pause time.Duration
	for {
		cmd := exec.Command(node, bundle)
		cmd.Dir = h.Dir
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = out, out
		hideChild(cmd)
		started := time.Now()
		if err := cmd.Start(); err != nil {
			return err
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-sigs:
			stopChild(cmd)
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				_ = cmd.Process.Kill()
			}
			return nil
		case err := <-done:
			code := 0
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else if err != nil {
				code = 1
			}
			if code == exitUnpaired {
				say("bridge: stopped: this machine isn't paired; run `dovre bridge login <handle>`")
				return nil
			}
			if !AfterExit(code) {
				return nil
			}
			pause = NextPause(time.Since(started), pause)
			say("bridge: exited (%d); starting again in %s", code, pause)
			select {
			case <-sigs:
				return nil
			case <-time.After(pause):
			}
		}
	}
}

// openLog: the bridge's log, started afresh once it's past 5 MB (connections only, never what agents say).
func openLog(file string) *os.File {
	if st, err := os.Stat(file); err == nil && st.Size() > 5<<20 {
		_ = os.Rename(file, file+".1")
	}
	_ = os.MkdirAll(filepath.Dir(file), 0o700)
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		f, _ = os.Open(os.DevNull)
	}
	return f
}

func readPid(file string) int {
	b, _ := os.ReadFile(file)
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func bridgeInstall(h BridgeHome) error {
	if _, ok := loadCreds(h.Creds()); !ok {
		return errors.New("pair this machine first: dovre bridge login <handle>")
	}
	// Fetched now, where a failure is seen, not at the next login.
	if _, err := ensureNode(h.Runtime(), os.Stdout); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	home, _ := os.UserHomeDir()
	where, err := serviceInstall(Service{Exe: exe, Path: os.Getenv("PATH"), Home: home, Log: h.Log(), Dir: h.Dir})
	if err != nil {
		return err
	}
	fmt.Printf("The bridge starts at login (%s) and is starting now. Log: %s\n", where, h.Log())
	return nil
}

func bridgeUninstall(h BridgeHome) error {
	if err := serviceUninstall(); err != nil {
		return err
	}
	// Started some other way (by hand, the Run key): stop that too.
	if pid := readPid(h.Pid()); pid > 0 && alive(pid) {
		stopBridge(pid)
	}
	fmt.Println("The bridge is stopped and won't start at login. Still paired: `dovre bridge install` starts it again.")
	return nil
}

func bridgeStatus(h BridgeHome) error {
	c, ok := loadCreds(h.Creds())
	if !ok {
		fmt.Println("Not paired. Pair this machine with: dovre bridge login <handle>")
		return nil
	}
	fmt.Printf("Paired as %q with %s (machine %s)\n", c.Name, strings.TrimPrefix(strings.TrimSuffix(c.Hub, "/bridge"), "wss://"), c.Machine)
	if serviceInstalled() {
		fmt.Println("Starts at login: yes")
	} else {
		fmt.Println("Starts at login: no (dovre bridge install)")
	}
	if pid := readPid(h.Pid()); pid > 0 && alive(pid) {
		fmt.Printf("Running: yes (pid %d)\n", pid)
	} else {
		fmt.Println("Running: no")
	}
	if b, err := os.ReadFile(h.Log()); err == nil {
		lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
		if len(lines) > 3 {
			lines = lines[len(lines)-3:]
		}
		fmt.Printf("Log (%s):\n  %s\n", h.Log(), strings.Join(lines, "\n  "))
	}
	return nil
}
