package main

// Codex (`codex exec --json`), as src/agents/harnesses/codex/ reads it.

// keepCodex keeps what src/agents/harnesses/codex/ reads from `codex exec --json` (types are dotted):
// the thread id, finished items by kind with only what a page shows (the agent's message, a
// command line and its status, the paths a change touched, an MCP tool's name, a search query, an
// error), its plan as it changes (a todo list's steps), and a turn's token counts or failure. Never
// a command's output, reasoning, or a change's diff.
func keepCodex(j map[string]any) []byte {
	out := map[string]any{"type": j["type"]}
	switch j["type"] {
	case "thread.started":
		out["thread_id"] = str(j["thread_id"], 100)
	case "item.started", "item.updated":
		// Only the plan, as it changes; every other item is read when it's done.
		it := obj(j["item"])
		if it["type"] != "todo_list" {
			return nil
		}
		out["item"] = map[string]any{"id": str(it["id"], 100), "type": "todo_list", "items": slimSteps(it["items"])}
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
		case "todo_list":
			kept["items"] = slimSteps(it["items"])
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
	return marshal(out)
}

// slimSteps keeps a todo list's steps: each one's words and whether it's done.
func slimSteps(v any) []any {
	list, _ := v.([]any)
	var out []any
	for i, t := range list {
		if i == 30 {
			break
		}
		tt := obj(t)
		out = append(out, map[string]any{"text": str(tt["text"], 300), "completed": tt["completed"] == true})
	}
	return out
}
