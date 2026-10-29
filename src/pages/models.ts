/** The mode and model pickers for an agent turn (new sessions, replies, agent reviews). */
import { html } from "hono/html";
import { modelsOf as modelsFor } from "../agents/harnesses/index.ts";
import { type HarnessId, MODES } from "../agents/runner.ts";
import { HARNESS_NAME } from "./parts.ts";

export const MODE_SHORT: Record<string, string> = { default: "asks first", acceptEdits: "edits freely", plan: "plan only" };
const MODE_LABEL: Record<string, string> = { default: "Ask before edits and commands", acceptEdits: "Edit files freely, ask before commands", plan: "Plan only: read, don't change anything" };
export const HARNESS_LABEL: Record<HarnessId, string> = HARNESS_NAME;

export const modeSelect = (current = "default") =>
  html`<label class="field"><span class="label">Mode</span><select name="mode">${MODES.map((m) => html`<option value="${m}"${m === current ? html` selected` : ""}>${MODE_LABEL[m]}</option>`)}</select></label>`;
const options = (list: { value: string; label: string }[], current: string | null) => list.map((m) => html`<option value="${m.value}"${m.value === current ? html` selected` : ""}>${m.label}</option>`);
/** One harness's models; with several harnesses, each in its own group (the server checks the pair). */
export const modelSelect = (current = "", harnesses: HarnessId[] = ["claude"]) =>
  html`<label class="field"><span class="label">Model</span><select name="model">${
    harnesses.length === 1
      ? options(modelsFor(harnesses[0]), current)
      : // Every group has a default (""): only the first is picked, else the browser shows the last group's.
        harnesses.map((h, i) => html`<optgroup label="${HARNESS_LABEL[h]}">${options(modelsFor(h), current === "" && i > 0 ? null : current)}</optgroup>`)
  }</select></label>`;
