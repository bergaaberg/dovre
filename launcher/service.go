package main

// Starting the bridge at login (`dovre bridge install`), the way each OS does it for one user,
// without admin rights:
//
//   - macOS: a launchd agent, ~/Library/LaunchAgents/dev.dovre.bridge.plist
//   - Linux: a systemd user unit, ~/.config/systemd/user/dovre-bridge.service (it stops at logout
//     unless lingering is on: `loginctl enable-linger`)
//   - Windows: the HKCU Run key (a Task Scheduler logon task needs admin rights)
//
// Each runs `dovre bridge run`, which starts the bundle again itself when it stops. The PATH of
// the shell that installed it goes along on macOS and Linux, so the agent CLIs are found.
// The files are made by the functions below, which are plain text and tested on any OS.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	launchdLabel = "dev.dovre.bridge"
	systemdUnit  = "dovre-bridge.service"
	runKey       = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	runValue     = "DovreBridge"
)

// Service: what the login item runs, and with what.
type Service struct {
	Exe  string // this binary
	Path string // PATH to run with
	Home string
	Log  string
	Dir  string // the bridge's folder (working directory)
}

func xmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// LaunchdPlist: started at login, and again if it stops other than cleanly (an unpaired machine exits 0).
func LaunchdPlist(s Service) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>` + launchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + xmlEsc(s.Exe) + `</string>
    <string>bridge</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>` + xmlEsc(s.Dir) + `</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>` + xmlEsc(s.Path) + `</string>
    <key>HOME</key><string>` + xmlEsc(s.Home) + `</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>` + xmlEsc(s.Log) + `</string>
</dict>
</plist>
`
}

// systemdQuote: one argument for ExecStart= or a value for Environment=.
func systemdQuote(s string) string {
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(s)
	return `"` + s + `"`
}

// SystemdUnit: started at login, and again if it fails (an unpaired machine exits 0).
func SystemdUnit(s Service) string {
	return `[Unit]
Description=Dovre bridge: this machine's agents in hosted Dovre
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=` + systemdQuote(s.Exe) + ` bridge run
WorkingDirectory=` + systemdQuote(s.Dir) + `
Environment=` + systemdQuote("PATH="+s.Path) + `
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
}

// RunCommand: the Run key's command line, the console-less build when there is one.
func RunCommand(exe string) string {
	if w := filepath.Join(filepath.Dir(exe), "dovrew.exe"); strings.EqualFold(filepath.Ext(exe), ".exe") && exists(w) {
		exe = w
	}
	return `"` + exe + `" bridge run`
}

func launchdPlistFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func systemdUnitFile() string {
	d, err := os.UserConfigDir()
	if err != nil {
		home, _ := os.UserHomeDir()
		d = filepath.Join(home, ".config")
	}
	return filepath.Join(d, "systemd", "user", systemdUnit)
}

func launchdDomain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

func runQuiet(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// serviceInstall writes the login item and starts it; it says where it went.
func serviceInstall(s Service) (string, error) {
	switch runtime.GOOS {
	case "darwin":
		file := launchdPlistFile()
		// The self-hosted bridge (scripts/install-bridge.sh) used this label before: moved, not overwritten.
		if b, err := os.ReadFile(file); err == nil && strings.Contains(string(b), "src/bridge/main.ts") {
			return "", errors.New("a self-hosted bridge (scripts/install-bridge.sh) has this machine's login item: run that script again first, which moves it aside")
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(file, []byte(LaunchdPlist(s)), 0o600); err != nil {
			return "", err
		}
		_ = runQuiet("launchctl", "bootout", launchdDomain()+"/"+launchdLabel)
		// bootout returns before the old agent is gone; bootstrapping then fails.
		for i := 0; i < 20 && runQuiet("launchctl", "print", launchdDomain()+"/"+launchdLabel) == nil; i++ {
			time.Sleep(500 * time.Millisecond)
		}
		if err := runQuiet("launchctl", "bootstrap", launchdDomain(), file); err != nil {
			time.Sleep(2 * time.Second)
			if err := runQuiet("launchctl", "bootstrap", launchdDomain(), file); err != nil {
				return "", err
			}
		}
		return file, nil
	case "linux":
		file := systemdUnitFile()
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(file, []byte(SystemdUnit(s)), 0o644); err != nil {
			return "", err
		}
		if err := runQuiet("systemctl", "--user", "daemon-reload"); err != nil {
			return "", err
		}
		if err := runQuiet("systemctl", "--user", "enable", "--now", systemdUnit); err != nil {
			return "", err
		}
		_ = runQuiet("systemctl", "--user", "restart", systemdUnit)
		return file + " (it stops at logout unless `loginctl enable-linger` is on)", nil
	case "windows":
		cmd := RunCommand(s.Exe)
		if err := runQuiet("reg", "add", runKey, "/v", runValue, "/t", "REG_SZ", "/d", cmd, "/f"); err != nil {
			return "", err
		}
		return runKey + `\` + runValue, startDetachedBridge(s.Exe)
	}
	return "", fmt.Errorf("starting at login isn't supported on %s: run `dovre bridge run` yourself", runtime.GOOS)
}

// startDetachedBridge: Windows has no service manager here, so install and restart start it themselves.
func startDetachedBridge(exe string) error {
	if w := filepath.Join(filepath.Dir(exe), "dovrew.exe"); exists(w) {
		exe = w
	}
	return Detached(exe, "bridge", "run")
}

func serviceUninstall() error {
	switch runtime.GOOS {
	case "darwin":
		file := launchdPlistFile()
		if b, err := os.ReadFile(file); err == nil && strings.Contains(string(b), "src/bridge/main.ts") {
			return errors.New("the login item is the self-hosted bridge's: remove it with `sh scripts/install-bridge.sh --remove`")
		}
		_ = runQuiet("launchctl", "bootout", launchdDomain()+"/"+launchdLabel)
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	case "linux":
		_ = runQuiet("systemctl", "--user", "disable", "--now", systemdUnit)
		if err := os.Remove(systemdUnitFile()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		_ = runQuiet("systemctl", "--user", "daemon-reload")
	case "windows":
		_ = runQuiet("reg", "delete", runKey, "/v", runValue, "/f")
	}
	return nil
}

func serviceInstalled() bool {
	switch runtime.GOOS {
	case "darwin":
		b, err := os.ReadFile(launchdPlistFile())
		return err == nil && !strings.Contains(string(b), "src/bridge/main.ts")
	case "linux":
		return exists(systemdUnitFile())
	case "windows":
		return runQuiet("reg", "query", runKey, "/v", runValue) == nil
	}
	return false
}

// serviceRestart: after a new login, the running bridge picks up the new sign-in.
func serviceRestart(h BridgeHome) error {
	switch runtime.GOOS {
	case "darwin":
		return runQuiet("launchctl", "kickstart", "-k", launchdDomain()+"/"+launchdLabel)
	case "linux":
		return runQuiet("systemctl", "--user", "restart", systemdUnit)
	case "windows":
		if pid := readPid(h.Pid()); pid > 0 && alive(pid) {
			stopBridge(pid)
			time.Sleep(time.Second)
		}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		return startDetachedBridge(exe)
	}
	return nil
}
