package main

// The parts of the launcher that are plain logic: what a command line or a dovre:// link asks
// for, the URLs it opens, reading the login token, the installed app's id from its shortcut, the
// listener table Windows hands back, and how long the supervisor pauses after a crash.
// Tested in paths_test.go; the Windows calls are in win.go.

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// Paths: where Dovre lives (the repo), its data folder, and the port it listens on.
type Paths struct {
	Root string
	Data string
	Port int
}

func (p Paths) Base() string            { return fmt.Sprintf("http://127.0.0.1:%d", p.Port) }
func (p Paths) File(name string) string { return filepath.Join(p.Data, name) }

// UpFile is written by the server once it listens; the launcher's starting page waits for it.
func (p Paths) UpFile() string { return p.File(fmt.Sprintf("up-%d.js", p.Port)) }

// StartingPage is the page the server wrote last time, opened before there's a server to ask.
func (p Paths) StartingPage() string { return p.File(fmt.Sprintf("starting-%d.html", p.Port)) }

var safePathRe = regexp.MustCompile(`^/[A-Za-z0-9_\-/]*$`)

// SafePath: only this app's own pages, so a link can't send the window anywhere else.
func SafePath(p string) bool { return safePathRe.MatchString(p) && !strings.Contains(p, "//") }

// Invocation turns the command line into a verb and its argument. A dovre:// link (from the
// starting page's button, so from any web page) may only open a page: it never stops or restarts.
func Invocation(args []string) (verb, arg string) {
	if len(args) == 0 {
		return "open", "/"
	}
	first := args[0]
	if strings.HasPrefix(strings.ToLower(first), "dovre:") {
		u, err := url.Parse(first)
		if err != nil {
			return "open", "/"
		}
		// dovre://open/agents: the host is the verb, the path the page.
		path := u.Path
		if path == "" || !SafePath(path) {
			path = "/"
		}
		return "open", path
	}
	verb = strings.ToLower(first)
	if len(args) > 1 {
		arg = args[1]
	}
	if verb == "open" || verb == "boot" {
		if arg == "" || !SafePath(arg) {
			arg = "/"
		}
	}
	return verb, arg
}

// Token reads LAUNCH_TOKEN from .dev.vars; "" when there's none.
func Token(devVars []byte) string {
	sc := bufio.NewScanner(bytes.NewReader(devVars))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != "LAUNCH_TOKEN" {
			continue
		}
		return strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return ""
}

// LoginToken: the token pinned in .dev.vars, else the one the server made and kept in
// data/launch-token (src/boot.ts); "" when there's neither yet (a first start: the window then
// gets the starting page, and the cookie comes with the next open).
func LoginToken(devVars, kept []byte) string {
	if t := Token(devVars); t != "" {
		return t
	}
	t := strings.TrimSpace(string(kept))
	if tokenRe.MatchString(t) {
		return t
	}
	return ""
}

var tokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// AppURL: the page, through /login when there's a token (a window without the cookie gets it).
func AppURL(base, token, path string) string {
	if token == "" {
		return base + path
	}
	return base + "/login?tk=" + url.QueryEscape(token) + "&next=" + url.QueryEscape(path)
}

// StartingURL: the starting page on disk, told where to go once the server answers.
func StartingURL(file, to string) string {
	// A Windows path (C:\x) has its separators turned on any OS; a POSIX one already starts with /.
	p := file
	if len(p) > 2 && p[1] == ':' {
		p = "/" + strings.ReplaceAll(p, `\`, "/")
	}
	u := url.URL{Scheme: "file", Path: p}
	return u.String() + "?to=" + url.QueryEscape(to)
}

// AppID finds `--app-id=<id>` in a shortcut Edge made for an installed app. A .lnk keeps its
// arguments as UTF-16; reading that one string is all the launcher needs from the format.
func AppID(lnk []byte) string {
	needle := utf16le("--app-id=")
	at := bytes.Index(lnk, needle)
	if at < 0 {
		return ""
	}
	var id []rune
	for i := at + len(needle); i+1 < len(lnk); i += 2 {
		r := rune(binary.LittleEndian.Uint16(lnk[i:]))
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			id = append(id, r)
			continue
		}
		break
	}
	return string(id)
}

func utf16le(s string) []byte {
	units := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(b[2*i:], u)
	}
	return b
}

// ListenerPID reads a MIB_TCPTABLE_OWNER_PID (GetExtendedTcpTable, listeners only): the process
// listening on 127.0.0.1 (or every address) at `port`, if any.
func ListenerPID(table []byte, port int) (uint32, bool) {
	if len(table) < 4 {
		return 0, false
	}
	n := int(binary.LittleEndian.Uint32(table))
	const row = 24 // state, local addr, local port, remote addr, remote port, pid
	for i := 0; i < n; i++ {
		off := 4 + i*row
		if off+row > len(table) {
			break
		}
		addr := binary.LittleEndian.Uint32(table[off+4:])
		raw := binary.LittleEndian.Uint32(table[off+8:])
		// The port is in network byte order in the low 16 bits.
		p := int(raw&0xff)<<8 | int(raw>>8&0xff)
		if p != port || (addr != 0x0100007f && addr != 0) {
			continue
		}
		return binary.LittleEndian.Uint32(table[off+20:]), true
	}
	return 0, false
}

// NextPause: how long the supervisor waits before starting the server again. One that ran a while
// had a one-off crash and comes back at once; one that dies straight away (it can't start) backs
// off, up to a minute.
func NextPause(ranFor, last time.Duration) time.Duration {
	if ranFor > 10*time.Second {
		return 500 * time.Millisecond
	}
	next := last * 2
	if next < 2*time.Second {
		next = 2 * time.Second
	}
	if next > time.Minute {
		next = time.Minute
	}
	return next
}
