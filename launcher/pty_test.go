package main

import (
	"bytes"
	"encoding/binary"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestFramesRoundTrip(t *testing.T) {
	var b bytes.Buffer
	_ = Frame(&b, 'i', []byte("git status\r"))
	_ = Frame(&b, 'r', []byte{120, 0, 32, 0})
	_ = Frame(&b, 'k', nil)
	kind, p, err := ReadFrame(&b)
	if err != nil || kind != 'i' || string(p) != "git status\r" {
		t.Fatalf("%c %q %v", kind, p, err)
	}
	kind, p, _ = ReadFrame(&b)
	if c, r, ok := Size(p); kind != 'r' || !ok || c != 120 || r != 32 {
		t.Fatalf("resize %v %d %d", ok, c, r)
	}
	if kind, p, _ = ReadFrame(&b); kind != 'k' || len(p) != 0 {
		t.Fatal("kill")
	}
	if _, _, err := ReadFrame(&b); err == nil {
		t.Fatal("end of input is an error")
	}
}

func TestOddFramesAreRefused(t *testing.T) {
	head := []byte{'i', 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(head[1:], 1<<21)
	if _, _, err := ReadFrame(bytes.NewReader(head)); err == nil {
		t.Fatal("a 2 MiB frame is refused")
	}
	if _, _, ok := Size([]byte{0, 0, 10, 0}); ok {
		t.Fatal("zero columns")
	}
	if _, _, ok := Size([]byte{1, 2}); ok {
		t.Fatal("short resize")
	}
}

func TestStartConsoleEchoAndResize(t *testing.T) {
	argv := []string{"/bin/sh", "-c", "read line; echo GOT:$line"}
	if runtime.GOOS == "windows" {
		argv = []string{"cmd.exe", "/c", "echo GOT:hello"}
	}
	c, err := StartConsole(argv, "", 80, 24)
	if err != nil {
		t.Fatalf("StartConsole: %v", err)
	}
	defer c.Kill()
	if err := c.Resize(100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	if runtime.GOOS != "windows" {
		_, _ = c.Write([]byte("hello\n"))
	}
	outCh := make(chan string, 1)
	go func() {
		var sb strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := c.Read(buf)
			if n > 0 {
				sb.Write(buf[:n])
				if strings.Contains(sb.String(), "GOT:hello") {
					outCh <- sb.String()
					return
				}
			}
			if err != nil {
				outCh <- sb.String()
				return
			}
		}
	}()
	select {
	case got := <-outCh:
		if !strings.Contains(got, "GOT:hello") {
			t.Fatalf("expected GOT:hello, got %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for PTY output")
	}
	code := c.Wait()
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}
}
