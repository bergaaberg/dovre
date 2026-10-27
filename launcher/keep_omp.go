package main

import (
	"fmt"
	"strings"
)

// omp (its JSON event stream), as src/agents/harnesses/omp/ reads it.

// keepOmp keeps the session id, text as it streams, tool calls with their slim input, the
// message's cost and stop reason, and omp's own "needs approval" refusal. Any other tool output stays out.
func keepOmp(j map[string]any) []byte {
	out := map[string]any{"type": j["type"]}
	switch j["type"] {
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
	return marshal(out)
}
