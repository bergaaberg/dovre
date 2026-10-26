package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNodeArchiveEveryTargetHasASum(t *testing.T) {
	for _, target := range [][2]string{{"darwin", "arm64"}, {"darwin", "amd64"}, {"linux", "amd64"}, {"linux", "arm64"}, {"windows", "amd64"}, {"windows", "arm64"}} {
		a, member, err := NodeArchive(target[0], target[1])
		if err != nil {
			t.Fatal(target, err)
		}
		if len(nodeSums[a]) != 64 {
			t.Errorf("%s: no checksum", a)
		}
		if !strings.HasPrefix(member, strings.TrimSuffix(strings.TrimSuffix(a, ".tar.gz"), ".zip")+"/") {
			t.Errorf("%s: member %s", a, member)
		}
	}
	if _, _, err := NodeArchive("freebsd", "amd64"); err == nil {
		t.Error("an OS the bridge doesn't ship on")
	}
}

func tarGz(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func serveBytes(b []byte) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(b) }))
}

func TestInstallNodeKeepsOnlyTheBinaryWhenTheSumMatches(t *testing.T) {
	archive := "node-x-darwin-arm64.tar.gz"
	body := tarGz(t, map[string]string{"node-x/README.md": "hi", "node-x/bin/node": "#!node"})
	srv := serveBytes(body)
	defer srv.Close()
	dir := t.TempDir()
	got, err := installNode(dir, srv.URL+"/", archive, "node-x/bin/node", sum(body), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(got); string(b) != "#!node" {
		t.Fatalf("got %q", b)
	}
	if st, _ := os.Stat(got); runtime.GOOS != "windows" && st.Mode()&0o111 == 0 {
		t.Error("not executable")
	}
	// Once there, it isn't fetched again.
	srv.Close()
	if again, err := installNode(dir, srv.URL+"/", archive, "node-x/bin/node", sum(body), io.Discard); err != nil || again != got {
		t.Fatal(again, err)
	}
}

func TestInstallNodeRefusesATamperedDownload(t *testing.T) {
	body := tarGz(t, map[string]string{"node-x/bin/node": "evil"})
	srv := serveBytes(body)
	defer srv.Close()
	dir := t.TempDir()
	_, err := installNode(dir, srv.URL+"/", "node-x.tar.gz", "node-x/bin/node", strings.Repeat("0", 64), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatal(err)
	}
	if exists(filepath.Join(dir, "node-"+nodeVersion, "node")) {
		t.Fatal("a download that didn't match was kept")
	}
}

func TestInstallNodeFromAZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("node-x/node.exe")
	_, _ = w.Write([]byte("MZ"))
	zw.Close()
	srv := serveBytes(buf.Bytes())
	defer srv.Close()
	got, err := installNode(t.TempDir(), srv.URL+"/", "node-x.zip", "node-x/node.exe", sum(buf.Bytes()), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(got) != "node.exe" {
		t.Fatal(got)
	}
}

func TestServerOK(t *testing.T) {
	for s, want := range map[string]bool{"https://dovre.dev": true, "http://127.0.0.1:8787": true, "http://dovre.dev": false, "https://dovre.dev/x": false, "dovre.dev": false} {
		if ServerOK(s) != want {
			t.Errorf("%s: want %v", s, want)
		}
	}
}

// A cockpit's pairing: a code, two polls pending (one asking to slow down), then the machine's sign-in.
func TestPairDeviceFlow(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/bridge/device":
			if body["handle"] != "alice" || body["name"] != "laptop" {
				t.Errorf("device: %v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "dc", "user_code": "ABCD-EFGH", "verification_uri": "https://alice.dovre.dev/cloud/bridge", "expires_in": 600, "interval": 5})
		case "/bridge/token":
			if body["device_code"] != "dc" || body["grant_type"] != "urn:ietf:params:oauth:grant-type:device_code" {
				t.Errorf("token: %v", body)
			}
			polls++
			switch polls {
			case 1:
				w.WriteHeader(400)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending"})
			case 2:
				w.WriteHeader(400)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "slow_down"})
			default:
				_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "jwt", "token_type": "Bearer", "expires_in": 600, "refresh_token": "rt", "machine": "m1", "name": "laptop", "handle": "alice", "hub": "wss://alice.dovre.dev/bridge", "frame_key": strings.Repeat("f", 64)})
			}
		}
	}))
	defer srv.Close()
	var waits []time.Duration
	var out bytes.Buffer
	c, err := Pair(srv.Client(), srv.URL, "alice", "laptop", &out, func(d time.Duration) { waits = append(waits, d) })
	if err != nil {
		t.Fatal(err)
	}
	if c.RefreshToken != "rt" || c.Machine != "m1" || c.Server != srv.URL || c.Hub != "wss://alice.dovre.dev/bridge" || c.Handle != "alice" {
		t.Fatalf("%+v", c)
	}
	if !strings.Contains(out.String(), "ABCD-EFGH") || !strings.Contains(out.String(), "https://alice.dovre.dev/cloud/bridge") {
		t.Fatal(out.String())
	}
	if len(waits) != 3 || waits[0] != 5*time.Second || waits[2] != 10*time.Second {
		t.Fatalf("waits %v: slow_down adds 5 s", waits)
	}
}

func TestPairUnknownHandleAndRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bridge/device" {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["handle"] == "nobody" {
				w.WriteHeader(404)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "dc", "user_code": "ABCD-EFGH", "expires_in": 600, "interval": 1})
			return
		}
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "access_denied"})
	}))
	defer srv.Close()
	if _, err := Pair(srv.Client(), srv.URL, "nobody", "x", io.Discard, func(time.Duration) {}); err == nil || !strings.Contains(err.Error(), "no cockpit") {
		t.Fatal(err)
	}
	if _, err := Pair(srv.Client(), srv.URL, "alice", "x", io.Discard, func(time.Duration) {}); err == nil || !strings.Contains(err.Error(), "turned down") {
		t.Fatal(err)
	}
}

func TestSaveCredsOwnerOnly(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sub", "bridge.json")
	want := Creds{Server: "https://dovre.dev", Handle: "alice", Machine: "m1", Name: "laptop", Hub: "wss://alice.dovre.dev/bridge", FrameKey: strings.Repeat("f", 64), RefreshToken: "rt"}
	if err := SaveCreds(file, want); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(file); runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
	got, ok := loadCreds(file)
	if !ok || got != want {
		t.Fatalf("%+v", got)
	}
	// The bundle (src/bridge/creds.ts) reads these names.
	b, _ := os.ReadFile(file)
	for _, k := range []string{`"server"`, `"handle"`, `"machine"`, `"name"`, `"hub"`, `"frame_key"`, `"refresh_token"`} {
		if !bytes.Contains(b, []byte(k)) {
			t.Errorf("no %s", k)
		}
	}
}

func TestAfterExit(t *testing.T) {
	for code, again := range map[int]bool{0: false, 1: true, 2: false, exitUnpaired: false, 137: true} {
		if AfterExit(code) != again {
			t.Errorf("exit %d: again %v", code, !again)
		}
	}
}

func TestLaunchdPlistEscapes(t *testing.T) {
	p := LaunchdPlist(Service{Exe: "/Users/a&b/bin/dovre", Path: "/usr/bin:/x<y>", Home: "/Users/a&b", Log: "/l", Dir: "/d"})
	for _, want := range []string{"<string>/Users/a&amp;b/bin/dovre</string>", "<string>bridge</string>", "<string>run</string>", "/x&lt;y&gt;", "<key>SuccessfulExit</key><false/>", "<string>dev.dovre.bridge</string>"} {
		if !strings.Contains(p, want) {
			t.Errorf("no %s in\n%s", want, p)
		}
	}
	if strings.Contains(p, "a&b") {
		t.Error("an unescaped &")
	}
}

func TestSystemdUnitQuotes(t *testing.T) {
	u := SystemdUnit(Service{Exe: `/home/a b/.dovre/bin/dovre`, Path: `/usr/bin:/home/a "q"/%h/$X`, Dir: "/home/a b/.config/dovre"})
	for _, want := range []string{`ExecStart="/home/a b/.dovre/bin/dovre" bridge run`, `Environment="PATH=/usr/bin:/home/a \"q\"/%%h/$$X"`, "Restart=on-failure", "WantedBy=default.target"} {
		if !strings.Contains(u, want) {
			t.Errorf("no %s in\n%s", want, u)
		}
	}
}

func TestRunCommandPrefersTheConsoleLessBuild(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "dovre.exe")
	if got := RunCommand(exe); got != `"`+exe+`" bridge run` {
		t.Fatal(got)
	}
	_ = os.WriteFile(filepath.Join(dir, "dovrew.exe"), nil, 0o755)
	if got := RunCommand(exe); got != `"`+filepath.Join(dir, "dovrew.exe")+`" bridge run` {
		t.Fatal(got)
	}
}

type fakeItem struct{ installed, removed bool }

func (f *fakeItem) Installed() bool  { return f.installed }
func (f *fakeItem) Uninstall() error { f.removed = true; f.installed = false; return nil }

func TestLogoutRevokesRemovesTheLoginItemAndForgets(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bridge/revoke" || r.Method != http.MethodPost {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()
	h := BridgeHome{t.TempDir()}
	if err := SaveCreds(h.Creds(), Creds{Server: srv.URL, Handle: "acme", Machine: "m1", Name: "kari-mbp", Hub: "wss://acme.dovre.dev/bridge", FrameKey: "k", RefreshToken: "rt-1"}); err != nil {
		t.Fatal(err)
	}
	item := &fakeItem{installed: true}
	var out bytes.Buffer
	if err := Logout(h, srv.Client(), item, &out); err != nil {
		t.Fatal(err)
	}
	if got["token"] != "rt-1" {
		t.Errorf("revoked %v", got)
	}
	if !item.removed {
		t.Error("the login item stays")
	}
	if exists(h.Creds()) {
		t.Error("bridge.json stays")
	}
	if !strings.Contains(out.String(), `"kari-mbp" is unpaired from acme.dovre.dev`) {
		t.Error(out.String())
	}
}

func TestLogoutForgetsEvenWhenTheServerIsDown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer srv.Close()
	h := BridgeHome{t.TempDir()}
	_ = SaveCreds(h.Creds(), Creds{Server: srv.URL, Name: "kari-mbp", Hub: "wss://acme.dovre.dev/bridge", RefreshToken: "rt-1"})
	var out bytes.Buffer
	if err := Logout(h, srv.Client(), &fakeItem{}, &out); err != nil {
		t.Fatal(err)
	}
	if exists(h.Creds()) {
		t.Error("bridge.json stays")
	}
	if !strings.Contains(out.String(), "https://acme.dovre.dev/cloud/bridge") || !strings.Contains(out.String(), "502") {
		t.Error(out.String())
	}
}

func TestLogoutNotPairedAndNoTokensOverHTTP(t *testing.T) {
	var out bytes.Buffer
	item := &fakeItem{installed: true}
	if err := Logout(BridgeHome{t.TempDir()}, http.DefaultClient, item, &out); err != nil {
		t.Fatal(err)
	}
	if !item.removed || !strings.Contains(out.String(), "Not paired") {
		t.Error(out.String())
	}
	if err := Revoke(http.DefaultClient, "http://dovre.dev", "rt"); err == nil {
		t.Error("a token over plain http")
	}
}
