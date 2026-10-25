package main

import (
	"encoding/binary"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestInvocation(t *testing.T) {
	cases := []struct {
		args      []string
		verb, arg string
	}{
		{nil, "open", "/"},
		{[]string{"status"}, "status", ""},
		{[]string{"open", "/agents"}, "open", "/agents"},
		{[]string{"open", "//evil.example"}, "open", "/"},
		{[]string{"open", "https://evil.example"}, "open", "/"},
		{[]string{"dovre://open/agents"}, "open", "/agents"},
		{[]string{"dovre://open"}, "open", "/"},
		// A link from a web page may only open a page.
		{[]string{"dovre://stop"}, "open", "/"},
		{[]string{"dovre://restart/x"}, "open", "/x"},
		{[]string{"dovre://open/a?b=../c"}, "open", "/a"},
		{[]string{"dovre://open/..%2f..%2fx"}, "open", "/"},
	}
	for _, c := range cases {
		v, a := Invocation(c.args)
		if v != c.verb || a != c.arg {
			t.Errorf("%q: got %q %q, want %q %q", c.args, v, a, c.verb, c.arg)
		}
	}
}

func TestToken(t *testing.T) {
	vars := []byte("# comment\r\nGHE_ORG=ACME\r\n  LAUNCH_TOKEN = \"abc-123\" \r\nLAUNCH_TOKEN=second\r\n")
	if got := Token(vars); got != "abc-123" {
		t.Fatalf("got %q", got)
	}
	if Token([]byte("NOPE=1")) != "" {
		t.Fatal("no token is none")
	}
}

func TestURLs(t *testing.T) {
	if got := AppURL("http://127.0.0.1:4848", "t k&x", "/agents"); got != "http://127.0.0.1:4848/login?tk=t+k%26x&next=%2Fagents" {
		t.Fatalf("got %q", got)
	}
	if got := AppURL("http://127.0.0.1:4848", "", "/"); got != "http://127.0.0.1:4848/" {
		t.Fatalf("got %q", got)
	}
	s := StartingURL(`C:\Users\Me Too\dovre\data\starting-4848.html`, "http://127.0.0.1:4848/login?tk=a&next=%2F")
	if !strings.HasPrefix(s, "file:///C:/Users/Me%20Too/dovre/data/starting-4848.html?to=") {
		t.Fatalf("got %q", s)
	}
	if got := StartingURL("/Users/me/src/dovre/data/starting-4848.html", "x"); got != "file:///Users/me/src/dovre/data/starting-4848.html?to=x" {
		t.Fatalf("POSIX: got %q", got)
	}
	q, _ := url.ParseQuery(s[strings.Index(s, "?")+1:])
	if q.Get("to") != "http://127.0.0.1:4848/login?tk=a&next=%2F" {
		t.Fatalf("to came back as %q", q.Get("to"))
	}
}

func TestAppID(t *testing.T) {
	lnk := append([]byte{0x4c, 0, 0, 0, 1, 2, 3}, utf16le(`--profile-directory=Default --app-id=abcdefghij0123 --app-url="x"`)...)
	if got := AppID(lnk); got != "abcdefghij0123" {
		t.Fatalf("got %q", got)
	}
	if AppID(utf16le("--profile-directory=Default")) != "" {
		t.Fatal("a shortcut without an app id isn't the app")
	}
}

func row(addr uint32, port int, pid uint32) []byte {
	b := make([]byte, 24)
	binary.LittleEndian.PutUint32(b[0:], 2) // LISTEN
	binary.LittleEndian.PutUint32(b[4:], addr)
	binary.LittleEndian.PutUint32(b[8:], uint32(port>>8&0xff|port&0xff<<8))
	binary.LittleEndian.PutUint32(b[20:], pid)
	return b
}

func TestListenerPID(t *testing.T) {
	table := make([]byte, 4)
	binary.LittleEndian.PutUint32(table, 3)
	table = append(table, row(0x0100007f, 135, 1)...)
	table = append(table, row(0x0a0a0a0a, 4848, 2)...) // another address: not ours
	table = append(table, row(0x0100007f, 4848, 77)...)
	if pid, ok := ListenerPID(table, 4848); !ok || pid != 77 {
		t.Fatalf("got %d %v", pid, ok)
	}
	if _, ok := ListenerPID(table, 4849); ok {
		t.Fatal("nobody listens on 4849")
	}
	if _, ok := ListenerPID([]byte{1}, 4848); ok {
		t.Fatal("a short table is empty")
	}
	short := append([]byte{}, table[:4+24]...) // says 3 rows, holds 1
	if _, ok := ListenerPID(short, 4848); ok {
		t.Fatal("rows past the end aren't read")
	}
}

func TestNextPause(t *testing.T) {
	if NextPause(2*time.Hour, time.Minute) != 500*time.Millisecond || NextPause(15*time.Second, 8*time.Second) != 500*time.Millisecond {
		t.Fatal("a crash after a long run comes back at once")
	}
	if NextPause(time.Second, 0) != 2*time.Second || NextPause(time.Second, 8*time.Second) != 16*time.Second || NextPause(time.Second, time.Minute) != time.Minute {
		t.Fatal("dying at once backs off, up to a minute")
	}
}

func TestLoginToken(t *testing.T) {
	kept := []byte("abcdefghijklmnopqrstuvwx\n")
	if got := LoginToken([]byte("LAUNCH_TOKEN=pinned-token-123456"), kept); got != "pinned-token-123456" {
		t.Fatalf("pinned first, got %q", got)
	}
	if got := LoginToken(nil, kept); got != "abcdefghijklmnopqrstuvwx" {
		t.Fatalf("then the kept one, got %q", got)
	}
	if LoginToken(nil, []byte("short")) != "" || LoginToken(nil, []byte("not a token; rm -rf")) != "" || LoginToken(nil, nil) != "" {
		t.Fatal("anything else is no token")
	}
}
