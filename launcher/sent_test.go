package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #145: each call home from login/logout is recorded, names and sizes only, and `dovre bridge sent` prints the record.
func TestSentRecordsCallsHome(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()
	file := filepath.Join(t.TempDir(), "bridge-data", sentFile)
	sentTo = file
	defer func() { sentTo = "" }()

	if err := Revoke(srv.Client(), srv.URL, "rt-secret"); err != nil {
		t.Fatal(err)
	}
	_, _ = postJSON(srv.Client(), "http://127.0.0.1:1/bridge/device", map[string]string{"handle": "alice"}, &struct{}{})

	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "rt-secret") || strings.Contains(string(raw), "alice") {
		t.Fatalf("a value was recorded: %s", raw)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 lines, got %q", lines)
	}
	var l sentLine
	_ = json.Unmarshal([]byte(lines[0]), &l)
	if l.K != "call" || l.Path != "/bridge/revoke" || l.Purpose != "bridge.revoke" || l.Status != 200 || strings.Join(l.Fields, ",") != "token" || l.Bytes == 0 {
		t.Fatalf("revoke line: %+v", l)
	}
	var l2 sentLine
	_ = json.Unmarshal([]byte(lines[1]), &l2)
	if l2.Status != 0 || l2.Purpose != "bridge.device" {
		t.Fatalf("a call that got no answer is recorded too: %+v", l2)
	}
	if st, _ := os.Stat(file); st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}

	// Frames, as the bridge writes them, summed per day.
	now := time.Now()
	hour := now.UnixMilli() - now.UnixMilli()%3600000
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
	for _, n := range []int{3, 4} {
		b, _ := json.Marshal(sentLine{K: "frames", Hour: hour, Host: "alice.dovre.dev", Kind: "state", Count: n, Bytes: n * 100})
		_, _ = f.Write(append(b, '\n'))
	}
	_, _ = f.Write([]byte("not json\n"))
	f.Close()
	var out bytes.Buffer
	if err := printSent(file, &out, now); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	for _, want := range []string{"POST 127.0.0.1", "/bridge/revoke", "bridge.revoke", "fields: token", "→ 200", "no answer", "alice.dovre.dev", "×7", "700 B"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in:\n%s", want, s)
		}
	}

	out.Reset()
	_ = printSent(filepath.Join(t.TempDir(), "none.jsonl"), &out, now)
	if !strings.Contains(out.String(), "no record yet") {
		t.Fatal(out.String())
	}
}
