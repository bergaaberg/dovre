package main

// Antigravity (`agy`), as src/agents/harnesses/agy/ reads it.

// keepAgy keeps what src/agents/harnesses/agy/ reads from agy's stream (lines carry "event", not "type"):
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
	return marshal(out)
}
