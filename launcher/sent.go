package main

// What the launcher sends home (#145): `dovre bridge login` and `logout` call the server they pair
// with. Each call is written to the bridge's record (bridge-data/sent.jsonl, the same lines as
// src/sent.ts) with its answer: field names and sizes, never values. `dovre bridge sent` prints it.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const sentFile = "sent.jsonl"
const keepDays = 30

// sentTo is the record calls home are written to; empty (tests, or no bridge home), they aren't.
var sentTo string

type sentLine struct {
	K       string   `json:"k"`
	At      int64    `json:"at,omitempty"`
	Host    string   `json:"host"`
	Path    string   `json:"path,omitempty"`
	Method  string   `json:"method,omitempty"`
	Purpose string   `json:"purpose,omitempty"`
	Status  int      `json:"status,omitempty"`
	Bytes   int      `json:"bytes"`
	Fields  []string `json:"fields,omitempty"`
	Hour    int64    `json:"hour,omitempty"`
	Kind    string   `json:"kind,omitempty"`
	Count   int      `json:"count,omitempty"`
}

// purposeOf names a call by its path: /bridge/device is bridge.device, and so on.
func purposeOf(path string) string {
	return strings.ReplaceAll(strings.Trim(path, "/"), "/", ".")
}

// fieldsOf: a JSON body's top-level field names, sorted; never their values.
func fieldsOf(body []byte) []string {
	var m map[string]json.RawMessage
	if json.Unmarshal(body, &m) != nil {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// recordSent appends one call to the record. A failure to write never stops the call.
func recordSent(to string, body []byte, status int) {
	if sentTo == "" {
		return
	}
	u, err := url.Parse(to)
	if err != nil {
		return
	}
	line, _ := json.Marshal(sentLine{K: "call", At: time.Now().UnixMilli(), Host: u.Host, Path: u.Path, Method: "POST", Purpose: purposeOf(u.Path), Status: status, Bytes: len(body), Fields: fieldsOf(body)})
	_ = os.MkdirAll(filepath.Dir(sentTo), 0o700)
	f, err := os.OpenFile(sentTo, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

// printSent: the last 30 days of the record, calls one by one, frames summed per day and kind.
func printSent(file string, out io.Writer, now time.Time) error {
	f, err := os.Open(file)
	if os.IsNotExist(err) {
		fmt.Fprintln(out, "Nothing sent: this machine's bridge has no record yet.")
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	since := now.Add(-keepDays * 24 * time.Hour).UnixMilli()
	var calls []sentLine
	type key struct {
		day        string
		host, kind string
	}
	days := map[key]*sentLine{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var l sentLine
		if json.Unmarshal(sc.Bytes(), &l) != nil {
			continue
		}
		switch l.K {
		case "call":
			if l.At >= since {
				calls = append(calls, l)
			}
		case "frames":
			if l.Hour >= since {
				k := key{time.UnixMilli(l.Hour).Format("2006-01-02"), l.Host, l.Kind}
				if days[k] == nil {
					days[k] = &sentLine{Host: l.Host, Kind: l.Kind}
				}
				days[k].Count += l.Count
				days[k].Bytes += l.Bytes
			}
		}
	}
	fmt.Fprintf(out, "What this machine sent home, the last %d days (%s)\n\nCalls:\n", keepDays, file)
	if len(calls) == 0 {
		fmt.Fprintln(out, "  none")
	}
	for _, c := range calls {
		status := "no answer"
		if c.Status > 0 {
			status = fmt.Sprint(c.Status)
		}
		fmt.Fprintf(out, "  %s  %s %s%s  %s  %d B  fields: %s  → %s\n", time.UnixMilli(c.At).Format("2006-01-02 15:04"), c.Method, c.Host, c.Path, c.Purpose, c.Bytes, strings.Join(c.Fields, ", "), status)
	}
	fmt.Fprintln(out, "\nFrames, per day:")
	if len(days) == 0 {
		fmt.Fprintln(out, "  none")
	}
	keys := make([]key, 0, len(days))
	for k := range days {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].day != keys[j].day {
			return keys[i].day > keys[j].day
		}
		if keys[i].host != keys[j].host {
			return keys[i].host < keys[j].host
		}
		return keys[i].kind < keys[j].kind
	})
	for _, k := range keys {
		d := days[k]
		fmt.Fprintf(out, "  %s  %s  %-14s ×%d  %d B\n", k.day, k.host, k.kind, d.Count, d.Bytes)
	}
	return nil
}
