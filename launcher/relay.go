package main

// `dovre relay -- <command> [args]`: an MCP stdio server that stands between a client and the
// real server, for clients that can't put a question to their user (MCP elicitation). omp is one:
// db-cli asks before it opens a production database, and through omp the answer was always no.
//
// The relay tells the server its client can ask, and when the server asks (an
// `elicitation/create` request), the question goes to Dovre, which shows it with Deny and
// Allow and rings a notification; your click is the answer. The model never sees the question
// and has no way to answer it: the answer comes from a page only you can press, as db-cli
// intends. Everything else passes through unchanged, line by line (MCP's stdio framing).
//
// It doesn't claim the newer multi-round-trip mechanism (protocol 2026-07-28), so a server on it
// falls back to asking with elicitation/create, which is the one the relay answers.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Answer is what the relay hands back to the server: an MCP ElicitResult.
type Answer struct {
	Action  string         `json:"action"`
	Content map[string]any `json:"content,omitempty"`
}

// Ask puts a question to the user and waits for the answer.
type Ask func(message string, schema json.RawMessage) (Answer, error)

// mrtrVersion is the first protocol version where a server may hand questions back inside a
// tool result instead of asking; the relay keeps the conversation below it.
const mrtrVersion = "2026-07-28"
const fallbackVersion = "2025-11-25"

type message struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// FromClient rewrites what the client sends: initialize gets the elicitation capability (and a
// protocol version below multi-round-trip). Anything else, or anything it can't read, is left alone.
func FromClient(line []byte) []byte {
	var m message
	if json.Unmarshal(line, &m) != nil || m.Method != "initialize" {
		return line
	}
	var all map[string]json.RawMessage
	if json.Unmarshal(line, &all) != nil {
		return line
	}
	var params map[string]any
	if len(m.Params) == 0 || json.Unmarshal(m.Params, &params) != nil || params == nil {
		params = map[string]any{}
	}
	if v, ok := params["protocolVersion"].(string); ok && v >= mrtrVersion {
		params["protocolVersion"] = fallbackVersion
	}
	caps, _ := params["capabilities"].(map[string]any)
	if caps == nil {
		caps = map[string]any{}
	}
	caps["elicitation"] = map[string]any{"form": map[string]any{}}
	params["capabilities"] = caps
	b, err := json.Marshal(params)
	if err != nil {
		return line
	}
	all["params"] = b
	out, err := json.Marshal(all)
	if err != nil {
		return line
	}
	return out
}

// IsElicitation: the server asking its client a question.
func IsElicitation(line []byte) (id json.RawMessage, params json.RawMessage, ok bool) {
	var m message
	if json.Unmarshal(line, &m) != nil || m.Method != "elicitation/create" || len(m.ID) == 0 {
		return nil, nil, false
	}
	return m.ID, m.Params, true
}

// Reply is the JSON-RPC response that carries the answer back to the server.
func Reply(id json.RawMessage, a Answer) []byte {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": a})
	return b
}

// Relay runs the conversation: client lines go to the server (initialize rewritten), server
// lines go to the client, except questions, which `ask` answers. Returns when the client is done.
func Relay(client io.Reader, toClient io.Writer, server io.Reader, toServer io.Writer, ask Ask) error {
	var serverMu, clientMu sync.Mutex
	writeServer := func(b []byte) error {
		serverMu.Lock()
		defer serverMu.Unlock()
		_, err := toServer.Write(append(b, '\n'))
		return err
	}
	writeClient := func(b []byte) error {
		clientMu.Lock()
		defer clientMu.Unlock()
		_, err := toClient.Write(append(b, '\n'))
		return err
	}
	done := make(chan error, 2)
	go func() {
		r := bufio.NewReader(server)
		for {
			line, err := r.ReadBytes('\n')
			if line = bytes.TrimRight(line, "\r\n"); len(line) > 0 {
				if id, params, ok := IsElicitation(line); ok {
					go func() {
						var p struct {
							Message         string          `json:"message"`
							RequestedSchema json.RawMessage `json:"requestedSchema"`
						}
						_ = json.Unmarshal(params, &p)
						a, err := ask(p.Message, p.RequestedSchema)
						if err != nil {
							// Nobody could be asked: closing the prompt unanswered, which a careful server reads as no.
							a = Answer{Action: "cancel"}
						}
						_ = writeServer(Reply(id, a))
					}()
				} else if werr := writeClient(line); werr != nil {
					done <- werr
					return
				}
			}
			if err != nil {
				done <- err
				return
			}
		}
	}()
	go func() {
		r := bufio.NewReader(client)
		for {
			line, err := r.ReadBytes('\n')
			if line = bytes.TrimRight(line, "\r\n"); len(line) > 0 {
				if werr := writeServer(FromClient(line)); werr != nil {
					done <- werr
					return
				}
			}
			if err != nil {
				done <- err
				return
			}
		}
	}()
	err := <-done
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// relay starts the real server and relays to it; questions go to Dovre.
func relay(p Paths, args []string) error {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		return errors.New("usage: dovre relay -- <command> [args]")
	}
	name := strings.TrimSuffix(filepath.Base(args[0]), filepath.Ext(args[0]))
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stderr = os.Stderr
	toServer, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	fromServer, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	ask := func(message string, schema json.RawMessage) (Answer, error) {
		return askDovre(p, name, message, schema)
	}
	err = Relay(os.Stdin, os.Stdout, fromServer, toServer, ask)
	_ = toServer.Close()
	_ = cmd.Wait()
	return err
}

// askDovre hands the question to Dovre (starting it if it isn't running) and waits for
// your answer, for up to ten minutes; then it's closed unanswered.
func askDovre(p Paths, server, message string, schema json.RawMessage) (Answer, error) {
	if !listening(p) {
		_ = os.Remove(p.UpFile())
		if err := startServer(p); err != nil {
			return Answer{}, err
		}
		if err := waitServer(p, 30*time.Second); err != nil {
			return Answer{}, err
		}
	}
	token := launchToken(p)
	if token == "" {
		return Answer{}, errors.New("no launch token to reach Dovre with")
	}
	c := http.Client{Timeout: 40 * time.Second}
	body, _ := json.Marshal(map[string]any{"server": server, "message": message, "schema": schema})
	req, _ := http.NewRequest("POST", p.Base()+"/relay/ask", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("cookie", "u_tk="+token)
	res, err := c.Do(req)
	if err != nil {
		return Answer{}, err
	}
	var made struct {
		ID string `json:"id"`
	}
	err = json.NewDecoder(res.Body).Decode(&made)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || made.ID == "" {
		return Answer{}, fmt.Errorf("Dovre didn't take the question (%d)", res.StatusCode)
	}
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest("GET", p.Base()+"/relay/ask/"+made.ID, nil)
		req.Header.Set("cookie", "u_tk="+token)
		res, err := c.Do(req)
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		var got struct {
			State  string `json:"state"`
			Answer Answer `json:"answer"`
		}
		err = json.NewDecoder(res.Body).Decode(&got)
		res.Body.Close()
		if err == nil && got.State == "answered" {
			return got.Answer, nil
		}
		if err == nil && got.State == "gone" {
			return Answer{Action: "cancel"}, nil
		}
	}
	return Answer{Action: "cancel"}, nil
}

// launchToken: the login secret, from .dev.vars or, when it isn't pinned there, data/launch-token.
func launchToken(p Paths) string {
	if b, err := os.ReadFile(filepath.Join(p.Root, ".dev.vars")); err == nil {
		if t := Token(b); t != "" {
			return t
		}
	}
	b, _ := os.ReadFile(p.File("launch-token"))
	return strings.TrimSpace(string(b))
}
