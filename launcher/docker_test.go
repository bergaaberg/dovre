package main

import (
	"strings"
	"testing"
)

func TestPipeName(t *testing.T) {
	if PipeName(true) != "dovre_docker" || PipeName(false) != "docker_engine" {
		t.Fatal("the pipe takes docker_engine only when Docker Desktop isn't serving it")
	}
}

func TestPipeSDDL(t *testing.T) {
	got := PipeSDDL("S-1-5-21-1-2-3-1001")
	if got != "D:P(A;;GA;;;S-1-5-21-1-2-3-1001)" {
		t.Fatal(got)
	}
	// One entry, protected: nobody but this user.
	if strings.Count(got, "(A;") != 1 || !strings.HasPrefix(got, "D:P") {
		t.Fatal(got)
	}
}

func TestHasDistro(t *testing.T) {
	if !HasDistro([]byte("docker-desktop\r\ndovre-docker\r\n"), DockerDistro) || HasDistro([]byte("docker-desktop\n"), DockerDistro) {
		t.Fatal("HasDistro")
	}
	// wsl.exe without WSL_UTF8 writes UTF-16: still read.
	utf16 := []byte("d\x00o\x00v\x00r\x00e\x00-\x00d\x00o\x00c\x00k\x00e\x00r\x00\r\x00\n\x00")
	if !HasDistro(utf16, DockerDistro) {
		t.Fatal("utf-16")
	}
	if HasDistro([]byte("dovre-docker-old\n"), DockerDistro) {
		t.Fatal("a longer name matched")
	}
}

func TestRelayArgs(t *testing.T) {
	a := strings.Join(relayArgs(), " ")
	if !strings.HasPrefix(a, "-d dovre-docker -u root --exec socat STDIO UNIX-CONNECT:/var/run/docker.sock") {
		t.Fatal(a)
	}
}
