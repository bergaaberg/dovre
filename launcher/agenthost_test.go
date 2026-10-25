package main

import (
	"strings"
	"testing"
)

func TestKeepDropsToolResultsAndFileContents(t *testing.T) {
	secret := "PROD-ROW-4242 secret=hunter2"
	dropped := []string{
		// Claude Code: tool results come back as user messages.
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"` + secret + `"}]}}`,
		`{"type":"system","subtype":"hook_response","output":"` + secret + `"}`,
		// omp: tool output, unless it's omp's own approval refusal.
		`{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","isError":false,"result":{"content":[{"type":"text","text":"` + secret + `"}]}}`,
		`{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","isError":true,"result":{"content":[{"type":"text","text":"` + secret + `"}]}}`,
		`{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"` + secret + `"}]}}`,
		`{"type":"turn_end","toolResults":["` + secret + `"]}`,
		`not json`,
	}
	for _, line := range dropped {
		if got := Keep([]byte(line)); got != nil {
			t.Errorf("kept %s → %s", line[:40], got)
		}
	}
	kept := map[string]string{
		`{"type":"system","subtype":"init","session_id":"s1","tools":["Bash"],"cwd":"C:/x"}`:                                                                                                              `{"session_id":"s1","subtype":"init","type":"system"}`,
		`{"type":"assistant","session_id":"s1","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","name":"Write","input":{"file_path":"a.txt","content":"` + secret + `"}}]}}`:    `{"message":{"content":[{"text":"Looking.","type":"text"},{"input":{"file_path":"a.txt"},"name":"Write","type":"tool_use"}]},"session_id":"s1","type":"assistant"}`,
		`{"type":"result","result":"Done.","total_cost_usd":0.01,"is_error":false,"session_id":"s1","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"gh pr view 1"}}],"usage":{"x":1}}`: `{"is_error":false,"permission_denials":[{"tool_input":{"command":"gh pr view 1"},"tool_name":"Bash"}],"result":"Done.","session_id":"s1","total_cost_usd":0.01,"type":"result"}`,
		`{"type":"tool_execution_end","toolCallId":"c2","toolName":"bash","isError":true,"result":{"content":[{"type":"text","text":"bash requires approval but no interactive UI is available"}]}}`:      `{"isError":true,"result":{"content":[{"text":"requires approval but no interactive UI","type":"text"}]},"toolCallId":"c2","toolName":"bash","type":"tool_execution_end"}`,
	}
	for in, want := range kept {
		if got := string(Keep([]byte(in))); got != want {
			t.Errorf("\n in  %s\n got %s\nwant %s", in[:50], got, want)
		}
		if strings.Contains(string(Keep([]byte(in))), "hunter2") {
			t.Errorf("a secret got through: %s", in[:50])
		}
	}
}

// agy's stream, as a real `agy --output-format stream-json` run printed it (2026-10-24).
func TestKeepKeepsAgysStreamAndNothingElse(t *testing.T) {
	secret := "PROD-ROW-4242 secret=hunter2"
	kept := map[string]string{
		`{"event":"init","conversation_id":"c1","init":{"cwd":"/x","tools":["run_command"],"secret":"` + secret + `"}}`: `{"conversation_id":"c1","event":"init"}`,
		`{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}`: `{"event":"step_update","step_update":{"conversation_id":"c1","state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}`,
		`{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"tool","tool_calls":[{"name":"run_command","args":{"command":"ls","output":"` + secret + `"}}],"tool_output":"` + secret + `"}}`: `{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"tool","tool_calls":[{"args":{"command":"ls"},"name":"run_command"}]}}`,
		`{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"OK\n","duration_seconds":5.7,"num_turns":1,"usage":{"input_tokens":7691,"output_tokens":166,"thinking_tokens":165,"total_tokens":7857}}}`: `{"event":"result","result":{"conversation_id":"c1","response":"OK\n","status":"SUCCESS","usage":{"input_tokens":7691,"output_tokens":166,"total_tokens":7857}}}`,
	}
	for in, want := range kept {
		got := string(Keep([]byte(in)))
		if got != want {
			t.Errorf("\n in  %s\n got %s\nwant %s", in[:50], got, want)
		}
		if strings.Contains(got, "hunter2") {
			t.Errorf("a secret got through: %s", in[:50])
		}
	}
	if got := Keep([]byte(`{"event":"tool_output","output":"` + secret + `"}`)); got != nil {
		t.Errorf("an unknown agy event was kept: %s", got)
	}
}

// Codex's stream, as `codex exec --json` documents it (written from the docs, no codex on the Mac yet).
func TestKeepKeepsCodexsStreamAndNothingElse(t *testing.T) {
	secret := "PROD-ROW-4242 secret=hunter2"
	kept := map[string]string{
		`{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}`: `{"thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53","type":"thread.started"}`,
		`{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"` + secret + `"}}`: ``,
		`{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"` + secret + `","exit_code":0,"status":"completed"}}`: `{"item":{"command":"bash -lc ls","exit_code":0,"id":"item_1","status":"completed","type":"command_execution"},"type":"item.completed"}`,
		`{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/a.ts","kind":"update","diff":"` + secret + `"}],"status":"completed"}}`: `{"item":{"changes":[{"kind":"update","path":"src/a.ts"}],"id":"item_2","status":"completed","type":"file_change"},"type":"item.completed"}`,
		`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}`: `{"item":{"id":"item_3","text":"Done.","type":"agent_message"},"type":"item.completed"}`,
		`{"type":"item.completed","item":{"id":"item_4","type":"mcp_tool_call","server":"gh","tool":"search","arguments":{"q":"` + secret + `"},"result":"` + secret + `","status":"completed"}}`: `{"item":{"id":"item_4","server":"gh","status":"completed","tool":"search","type":"mcp_tool_call"},"type":"item.completed"}`,
		`{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}`: `{"type":"turn.completed","usage":{"cached_input_tokens":24448,"input_tokens":24763,"output_tokens":122}}`,
		`{"type":"turn.failed","error":{"message":"stream disconnected"}}`: `{"error":{"message":"stream disconnected"},"type":"turn.failed"}`,
		`{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"cat .env","aggregated_output":"` + secret + `","status":"in_progress"}}`: ``,
		`{"type":"turn.started"}`: ``,
	}
	for in, want := range kept {
		got := string(Keep([]byte(in)))
		if got != want {
			t.Errorf("\n in  %s\n got %s\nwant %s", in[:50], got, want)
		}
		if strings.Contains(got, "hunter2") {
			t.Errorf("a secret got through: %s", in[:50])
		}
	}
}

func TestKeepKeepsACommandWholeForAllowAndContinue(t *testing.T) {
	long := strings.Repeat("x", 3000)
	got := string(Keep([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo ` + long + `"}}]}}`)))
	if !strings.Contains(got, long) {
		t.Fatal("the command was cut; allowing it exactly needs all of it")
	}
}

func TestKeepKeepsAQuestionWithItsChoices(t *testing.T) {
	got := string(Keep([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"T","multiSelect":false,"options":[{"label":"ledger:at","description":"Test"}]}],"secret":"x"}}]}}`)))
	for _, want := range []string{`"question":"Which?"`, `"label":"ledger:at"`, `"description":"Test"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %s in %s", want, got)
		}
	}
	if strings.Contains(got, "secret") {
		t.Fatal("other input keys stay out")
	}
}
