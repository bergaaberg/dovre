package main

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func TestFromClientAddsElicitationAndStaysBelowMultiRoundTrip(t *testing.T) {
	in := `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{"roots":{}},"clientInfo":{"name":"omp"}}}`
	var got struct {
		Params struct {
			ProtocolVersion string         `json:"protocolVersion"`
			Capabilities    map[string]any `json:"capabilities"`
			ClientInfo      map[string]any `json:"clientInfo"`
		} `json:"params"`
		ID int `json:"id"`
	}
	if err := json.Unmarshal(FromClient([]byte(in)), &got); err != nil {
		t.Fatal(err)
	}
	if got.Params.ProtocolVersion != fallbackVersion {
		t.Fatalf("version %q", got.Params.ProtocolVersion)
	}
	if _, ok := got.Params.Capabilities["elicitation"]; !ok {
		t.Fatal("no elicitation capability")
	}
	if _, ok := got.Params.Capabilities["roots"]; !ok || got.Params.ClientInfo["name"] != "omp" || got.ID != 0 {
		t.Fatal("the rest of initialize must stay as it was")
	}
	old := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`
	if !strings.Contains(string(FromClient([]byte(old))), `"protocolVersion":"2025-06-18"`) {
		t.Fatal("an older version is kept")
	}
	for _, other := range []string{`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"q"}}`, `not json`} {
		if string(FromClient([]byte(other))) != other {
			t.Fatalf("%s changed", other)
		}
	}
}

func TestElicitationIsAnsweredHereAndNeverReachesTheClient(t *testing.T) {
	clientIn, clientInW := io.Pipe()
	clientOutR, clientOut := io.Pipe()
	serverOutR, serverOut := io.Pipe()
	serverInR, serverIn := io.Pipe()
	asked := make(chan string, 1)
	ask := func(msg string, schema json.RawMessage) (Answer, error) {
		asked <- msg + " " + string(schema)
		return Answer{Action: "decline"}, nil
	}
	go Relay(clientIn, clientOut, serverOutR, serverIn, ask)
	toServer := bufio.NewReader(serverInR)
	toClient := bufio.NewReader(clientOutR)

	// The client's initialize reaches the server, with the capability.
	go clientInW.Write([]byte(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}` + "\n"))
	line, _ := toServer.ReadString('\n')
	if !strings.Contains(line, `"elicitation"`) {
		t.Fatalf("server got %s", line)
	}
	// The server asks: the relay answers it, the client hears nothing of it.
	go serverOut.Write([]byte(`{"jsonrpc":"2.0","id":7,"method":"elicitation/create","params":{"message":"Open PRODUCTION ledger?","requestedSchema":{"type":"object"}}}` + "\n"))
	select {
	case q := <-asked:
		if !strings.Contains(q, "Open PRODUCTION ledger?") {
			t.Fatalf("asked %q", q)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("never asked")
	}
	reply, _ := toServer.ReadString('\n')
	if !strings.Contains(reply, `"id":7`) || !strings.Contains(reply, `"action":"decline"`) {
		t.Fatalf("server got %s", reply)
	}
	// Everything else passes through to the client.
	go serverOut.Write([]byte(`{"jsonrpc":"2.0","id":3,"result":{"content":[]}}` + "\n"))
	passed, _ := toClient.ReadString('\n')
	if !strings.Contains(passed, `"id":3`) {
		t.Fatalf("client got %s", passed)
	}
}

func TestAnUnaskableQuestionIsClosedUnanswered(t *testing.T) {
	if got := string(Reply(json.RawMessage(`"q1"`), Answer{Action: "cancel"})); got != `{"id":"q1","jsonrpc":"2.0","result":{"action":"cancel"}}` {
		t.Fatalf("got %s", got)
	}
	if _, _, ok := IsElicitation([]byte(`{"jsonrpc":"2.0","method":"elicitation/create"}`)); ok {
		t.Fatal("a notification (no id) isn't a question")
	}
}
