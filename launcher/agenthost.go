package main

// `dovre agent-host --out F --err F --exit F -- <agent cli> [args]`: runs one agent turn for
// Dovre, apart from Dovre's own process, so the turn goes on when Dovre restarts, and
// Dovre picks it up again from what this writes.
//
// The agent's stream goes to --out filtered down to what Dovre shows (src/agents/runner.ts,
// src/agents/omp.ts): text, which tool was called with its command, path or pattern, permission
// denials, the result. Tool results and file contents never reach the disk: they can hold
// production data and secrets (CLAUDE.md). The prompt comes in on stdin and is passed on.
// When the agent ends, --exit gets {"code":N}.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// The tool-input keys Dovre reads (toolDetail, toolSpec, ompToolDetail). `command` is kept
// whole, since "Allow and continue" allows that exact command; the rest are cut short.
var inputKeys = map[string]int{"command": 4000, "file_path": 600, "notebook_path": 600, "path": 600, "pattern": 300, "url": 600, "description": 300, "prompt": 600, "query": 300}

func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func str(v any, n int) any {
	if s, ok := v.(string); ok {
		return cut(s, n)
	}
	return nil
}

// slimInput keeps the few keys a tool call is shown by, nothing else (no file contents).
func slimInput(v any) map[string]any {
	in, _ := v.(map[string]any)
	out := map[string]any{}
	for k, n := range inputKeys {
		if s := str(in[k], n); s != nil {
			out[k] = s
		}
	}
	return out
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }

// slimQuestions keeps AskUserQuestion's questions and choices, as src/agents/conversation.ts reads them.
func slimQuestions(v any) []any {
	list, _ := v.([]any)
	var out []any
	for i, q := range list {
		if i == 4 {
			break
		}
		qq := obj(q)
		var opts []any
		ol, _ := qq["options"].([]any)
		for j, o := range ol {
			if j == 6 {
				break
			}
			oo := obj(o)
			opts = append(opts, map[string]any{"label": str(oo["label"], 120), "description": str(oo["description"], 400)})
		}
		out = append(out, map[string]any{"question": str(qq["question"], 600), "header": str(qq["header"], 40), "multiSelect": qq["multiSelect"] == true, "options": opts})
	}
	return out
}

// Keep returns the line as it may be stored, or nil when nothing of it may be.
func Keep(line []byte) []byte {
	var j map[string]any
	if json.Unmarshal(line, &j) != nil {
		return nil
	}
	if _, typed := j["type"]; !typed {
		return keepAgy(j)
	}
	if t, _ := j["type"].(string); strings.HasPrefix(t, "thread.") || strings.HasPrefix(t, "turn.") || strings.HasPrefix(t, "item.") {
		return keepCodex(j)
	}
	out := map[string]any{"type": j["type"]}
	switch j["type"] {
	// Claude Code (stream-json).
	case "system":
		if j["subtype"] != "init" {
			return nil
		}
		out["subtype"], out["session_id"] = "init", str(j["session_id"], 100)
	case "stream_event":
		ev := obj(j["event"])
		d := obj(ev["delta"])
		if ev["type"] != "content_block_delta" || d["type"] != "text_delta" {
			return nil
		}
		out["event"] = map[string]any{"type": "content_block_delta", "delta": map[string]any{"type": "text_delta", "text": str(d["text"], 20000)}}
	case "assistant":
		msg := obj(j["message"])
		var blocks []any
		list, _ := msg["content"].([]any)
		for _, b := range list {
			bb := obj(b)
			switch bb["type"] {
			case "text":
				blocks = append(blocks, map[string]any{"type": "text", "text": str(bb["text"], 50000)})
			case "tool_use":
				input := slimInput(bb["input"])
				// A question the agent puts to the user is shown with its choices: keep those (they're the agent's words).
				if bb["name"] == "AskUserQuestion" {
					input["questions"] = slimQuestions(obj(bb["input"])["questions"])
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "name": str(bb["name"], 100), "input": input})
			}
		}
		out["message"] = map[string]any{"content": blocks}
		out["session_id"] = str(j["session_id"], 100)
	case "result":
		out["result"], out["total_cost_usd"], out["is_error"], out["session_id"] = str(j["result"], 50000), j["total_cost_usd"], j["is_error"], str(j["session_id"], 100)
		var denials []any
		list, _ := j["permission_denials"].([]any)
		for _, d := range list {
			dd := obj(d)
			denials = append(denials, map[string]any{"tool_name": str(dd["tool_name"], 100), "tool_input": slimInput(dd["tool_input"])})
		}
		out["permission_denials"] = denials
	// omp (its JSON event stream).
	case "session":
		out["id"] = str(j["id"], 100)
	case "message_update":
		e := obj(j["assistantMessageEvent"])
		if e["type"] != "text_delta" {
			return nil
		}
		out["assistantMessageEvent"] = map[string]any{"type": "text_delta", "delta": str(e["delta"], 20000)}
	case "message_end":
		m := obj(j["message"])
		if m["role"] != "assistant" {
			return nil
		}
		var blocks []any
		list, _ := m["content"].([]any)
		for _, b := range list {
			bb := obj(b)
			switch bb["type"] {
			case "text":
				blocks = append(blocks, map[string]any{"type": "text", "text": str(bb["text"], 50000)})
			case "toolCall":
				blocks = append(blocks, map[string]any{"type": "toolCall", "id": str(bb["id"], 100), "name": str(bb["name"], 100), "arguments": slimInput(bb["arguments"])})
			}
		}
		cost := obj(obj(m["usage"])["cost"])["total"]
		out["message"] = map[string]any{"role": "assistant", "content": blocks, "usage": map[string]any{"cost": map[string]any{"total": cost}}, "stopReason": str(m["stopReason"], 40), "errorMessage": str(m["errorMessage"], 600)}
	case "tool_execution_start":
		out["toolCallId"], out["toolName"], out["args"] = str(j["toolCallId"], 100), str(j["toolName"], 100), slimInput(j["args"])
	case "tool_execution_end":
		// Only omp's own "needs approval" refusal, recognised here; any other tool output stays out.
		if j["isError"] != true {
			return nil
		}
		var text strings.Builder
		list, _ := obj(j["result"])["content"].([]any)
		for _, c := range list {
			if s, ok := obj(c)["text"].(string); ok {
				text.WriteString(s)
			}
		}
		if !strings.Contains(text.String(), "requires approval but no interactive UI") {
			return nil
		}
		out["toolCallId"], out["toolName"], out["isError"] = str(j["toolCallId"], 100), str(j["toolName"], 100), true
		out["result"] = map[string]any{"content": []any{map[string]any{"type": "text", "text": "requires approval but no interactive UI"}}}
	case "agent_end":
		out["isTerminal"] = j["isTerminal"]
	case "error":
		msg := j["message"]
		if msg == nil {
			msg = j["error"]
		}
		out["message"] = str(fmt.Sprint(msg), 600)
	default:
		return nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return b
}

// keepAgy keeps what src/agents/agy.ts reads from agy's stream (lines carry "event", not "type"):
// the conversation id, text as it streams, tool names with the same slim input, the final response
// and token counts. Never a tool's output, nor init's list of tools and folders.
func keepAgy(j map[string]any) []byte {
	out := map[string]any{"event": j["event"]}
	switch j["event"] {
	case "init":
		out["conversation_id"] = str(j["conversation_id"], 100)
	case "step_update":
		su := obj(j["step_update"])
		kept := map[string]any{"conversation_id": str(su["conversation_id"], 100), "state": str(su["state"], 40), "step_type": str(su["step_type"], 60)}
		if d, ok := su["text_delta"].(string); ok {
			kept["text_delta"] = cut(d, 20000)
		}
		if list, ok := su["tool_calls"].([]any); ok {
			var calls []any
			for _, c := range list {
				cc := obj(c)
				calls = append(calls, map[string]any{"name": str(cc["name"], 100), "args": slimInput(cc["args"])})
			}
			kept["tool_calls"] = calls
		}
		out["step_update"] = kept
	case "result":
		r := obj(j["result"])
		u := obj(r["usage"])
		out["result"] = map[string]any{
			"conversation_id": str(r["conversation_id"], 100),
			"status":          str(r["status"], 40),
			"response":        str(r["response"], 50000),
			"usage":           map[string]any{"input_tokens": u["input_tokens"], "output_tokens": u["output_tokens"], "total_tokens": u["total_tokens"]},
		}
	default:
		return nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return b
}

// keepCodex keeps what src/agents/codex.ts reads from `codex exec --json` (types are dotted):
// the thread id, finished items by kind with only what a page shows (the agent's message, a
// command line and its status, the paths a change touched, an MCP tool's name, a search query, an
// error), and a turn's token counts or failure. Never a command's output, reasoning, or a change's diff.
func keepCodex(j map[string]any) []byte {
	out := map[string]any{"type": j["type"]}
	switch j["type"] {
	case "thread.started":
		out["thread_id"] = str(j["thread_id"], 100)
	case "item.completed":
		it := obj(j["item"])
		kind, _ := it["type"].(string)
		if kind == "" {
			kind, _ = it["item_type"].(string)
		}
		kept := map[string]any{"id": str(it["id"], 100), "type": kind}
		switch kind {
		case "agent_message":
			kept["text"] = str(it["text"], 50000)
		case "command_execution":
			kept["command"], kept["status"], kept["exit_code"] = str(it["command"], 4000), str(it["status"], 40), it["exit_code"]
		case "file_change":
			var changes []any
			list, _ := it["changes"].([]any)
			for i, c := range list {
				if i == 50 {
					break
				}
				cc := obj(c)
				changes = append(changes, map[string]any{"path": str(cc["path"], 600), "kind": str(cc["kind"], 20)})
			}
			kept["changes"], kept["status"] = changes, str(it["status"], 40)
		case "mcp_tool_call":
			kept["server"], kept["tool"], kept["status"] = str(it["server"], 100), str(it["tool"], 100), str(it["status"], 40)
		case "web_search":
			kept["query"] = str(it["query"], 300)
		case "error":
			kept["message"] = str(it["message"], 600)
		default:
			return nil
		}
		out["item"] = kept
	case "turn.completed":
		u := obj(j["usage"])
		out["usage"] = map[string]any{"input_tokens": u["input_tokens"], "cached_input_tokens": u["cached_input_tokens"], "output_tokens": u["output_tokens"]}
	case "turn.failed":
		out["error"] = map[string]any{"message": str(obj(j["error"])["message"], 600)}
	default:
		return nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return b
}

func agentHost(args []string) error {
	fs := flag.NewFlagSet("agent-host", flag.ContinueOnError)
	outPath := fs.String("out", "", "filtered stream")
	errPath := fs.String("err", "", "the agent's stderr (the end of it)")
	exitPath := fs.String("exit", "", "where the exit code goes")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) == 0 || *outPath == "" || *exitPath == "" {
		return errors.New("usage: dovre agent-host --out F --err F --exit F -- <cli> [args]")
	}
	out, err := os.OpenFile(*outPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		// Say why where Dovre looks, when it can be written at all.
		if *errPath != "" {
			_ = os.WriteFile(*errPath, []byte(err.Error()), 0o600)
		}
		_ = os.WriteFile(*exitPath, []byte(`{"code":-1}`), 0o600)
		return err
	}
	defer out.Close()
	cmd := exec.Command(rest[0], rest[1:]...)
	cmd.Stdin = os.Stdin
	var stderr bytes.Buffer
	cmd.Stderr = &tail{buf: &stderr, max: 8000}
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	hideChild(cmd)
	code := -1
	if err := cmd.Start(); err != nil {
		_ = os.WriteFile(*errPath, []byte(err.Error()), 0o600)
	} else {
		r := bufio.NewReader(pipe)
		for {
			line, rerr := r.ReadBytes('\n')
			if kept := Keep(bytes.TrimSpace(line)); kept != nil {
				_, _ = out.Write(append(kept, '\n'))
			}
			if rerr != nil {
				break
			}
		}
		_ = cmd.Wait()
		code = cmd.ProcessState.ExitCode()
		if *errPath != "" && stderr.Len() > 0 {
			_ = os.WriteFile(*errPath, stderr.Bytes(), 0o600)
		}
	}
	b, _ := json.Marshal(map[string]int{"code": code})
	return os.WriteFile(*exitPath, b, 0o600)
}

// tail keeps the last `max` bytes written to it.
type tail struct {
	buf *bytes.Buffer
	max int
}

func (t *tail) Write(p []byte) (int, error) {
	t.buf.Write(p)
	if over := t.buf.Len() - t.max; over > 0 {
		rest := append([]byte(nil), t.buf.Bytes()[over:]...)
		t.buf.Reset()
		t.buf.Write(rest)
	}
	return len(p), nil
}

var _ io.Writer = (*tail)(nil)
