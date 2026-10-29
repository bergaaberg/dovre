package main

// Claude Code (`claude -p --output-format stream-json`), as src/agents/harnesses/claude/ reads it.

// The stream-json line types that are Claude Code's.
var claudeTypes = map[string]bool{"system": true, "stream_event": true, "assistant": true, "result": true}

// keepClaude keeps the session id, text as it streams, tool calls with their slim input (and
// AskUserQuestion's choices, TodoWrite's items, a subagent call's type), and the result with its
// cost and denials. Never a tool's result, so never what a subagent found.
func keepClaude(j map[string]any) []byte {
	out := map[string]any{"type": j["type"]}
	switch j["type"] {
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
				// Its to-do list: each item's words and status (the agent's own plan).
				if bb["name"] == "TodoWrite" {
					input["todos"] = slimTodos(obj(bb["input"])["todos"])
				}
				// A subagent call: which kind of agent; its description and prompt are slim keys already.
				if bb["name"] == "Task" || bb["name"] == "Agent" {
					if s := str(obj(bb["input"])["subagent_type"], 100); s != nil {
						input["subagent_type"] = s
					}
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
	default:
		return nil
	}
	return marshal(out)
}
