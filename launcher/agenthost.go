package main

// `dovre agent-host --out F --err F --exit F -- <agent cli> [args]`: runs one agent turn for
// Dovre, apart from Dovre's own process, so the turn goes on when Dovre restarts, and
// Dovre picks it up again from what this writes.
//
// The agent's stream goes to --out filtered down to what Dovre shows (src/agents/harnesses/<id>/,
// one keep_<id>.go each here): text, which tool was called with its command, path or pattern, permission
// denials, the result. Tool results and file contents never reach the disk: they can hold
// production data and secrets (CLAUDE.md). The prompt comes in on stdin and is passed on.
// When the agent ends, --exit gets {"code":N}.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
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

// Keep returns the line as it may be stored, or nil when nothing of it may be. Each harness's
// filter is in its own file (keep_<id>.go), next to its adapter in src/agents/harnesses/<id>/.
func Keep(line []byte) []byte {
	var j map[string]any
	if json.Unmarshal(line, &j) != nil {
		return nil
	}
	_, typed := j["type"]
	t, _ := j["type"].(string)
	switch {
	case !typed:
		return keepAgy(j)
	case strings.HasPrefix(t, "thread.") || strings.HasPrefix(t, "turn.") || strings.HasPrefix(t, "item."):
		return keepCodex(j)
	case claudeTypes[t]:
		return keepClaude(j)
	default:
		return keepOmp(j)
	}
}

// marshal is the kept line, or nil when it can't be written.
func marshal(out map[string]any) []byte {
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
