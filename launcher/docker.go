package main

// Docker without Docker Desktop: Docker Engine runs in a WSL distro of its own (made by
// scripts/docker.ps1), and the supervisor serves it on a Windows named pipe, so the docker CLI,
// Testcontainers, Rider and Dovre reach it the way they reach Docker Desktop. Each connection
// to the pipe is relayed into the distro (wsl.exe running socat against /var/run/docker.sock).
//
// WSL stops a distro a few seconds after the last Windows process attached to it ends, and its
// containers with it, so while the engine is on the supervisor keeps one process attached. Off
// (data/docker-off, written by the Docker page's Stop) the pipe turns connections away instead of
// starting the distro again behind the page's back.
//
// The pipe is only for this user (its security descriptor names this user's SID alone) and only
// for this machine (remote clients refused). Plain logic here; the Windows calls are in
// dockerpipe_windows.go.

import "strings"

// DockerDistro is the WSL distro scripts/docker.ps1 makes.
const DockerDistro = "dovre-docker"

// Docker Desktop's pipe. Ours takes it once Desktop is gone; until then ours is dovre_docker.
const desktopPipe = "docker_engine"
const ownPipe = "dovre_docker"

// PipeName: docker_engine when nothing else serves it, else a name of our own beside it.
func PipeName(desktopServing bool) string {
	if desktopServing {
		return ownPipe
	}
	return desktopPipe
}

// PipeSDDL: full access for this user's SID and nobody else, not even administrators or SYSTEM
// (protected, so nothing is inherited).
func PipeSDDL(sid string) string { return "D:P(A;;GA;;;" + sid + ")" }

// HasDistro reads `wsl --list --quiet` (run with WSL_UTF8=1).
func HasDistro(list []byte, name string) bool {
	for _, line := range strings.Split(strings.ReplaceAll(string(list), "\x00", ""), "\n") {
		if strings.EqualFold(strings.TrimSpace(line), name) {
			return true
		}
	}
	return false
}

// relayArgs: what wsl.exe runs for one connection. --exec: no shell in between.
func relayArgs() []string {
	return []string{"-d", DockerDistro, "-u", "root", "--exec", "socat", "STDIO", "UNIX-CONNECT:/var/run/docker.sock"}
}

// keepArgs: the process that keeps the distro (and so the engine) running.
func keepArgs() []string {
	return []string{"-d", DockerDistro, "-u", "root", "--exec", "sleep", "infinity"}
}
