/** The mode and model pickers for an agent turn (new sessions, replies, agent reviews). */
import { html } from "hono/html";
import { AGY_MODELS } from "../agents/agy.ts";
import { CODEX_MODELS } from "../agents/codex.ts";
import { OMP_MODELS } from "../agents/omp.ts";
import { type HarnessId, MODELS, MODES } from "../agents/runner.ts";
import { HARNESS_NAME } from "./parts.ts";

export const MODE_SHORT: Record<string, string> = { default: "asks first", acceptEdits: "edits freely", plan: "plan only" };
const MODE_LABEL: Record<string, string> = { default: "Ask before edits and commands", acceptEdits: "Edit files freely, ask before commands", plan: "Plan only: read, don't change anything" };
const CLAUDE_MODELS: { value: string; label: string }[] = MODELS.map((m) => ({ value: m, label: { "": "Default model", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" }[m] ?? m }));
export const HARNESS_LABEL: Record<HarnessId, string> = HARNESS_NAME;

export const modeSelect = (current = "default") =>
  html`<label class="field"><span class="label">Mode</span><select name="mode">${MODES.map((m) => html`<option value="${m}"${m === current ? html` selected` : ""}>${MODE_LABEL[m]}</option>`)}</select></label>`;
const options = (list: { value: string; label: string }[], current: string) => list.map((m) => html`<option value="${m.value}"${m.value === current ? html` selected` : ""}>${m.label}</option>`);
const modelsFor = (h: HarnessId) => (h === "omp" ? OMP_MODELS : h === "agy" ? AGY_MODELS : h === "codex" ? CODEX_MODELS : CLAUDE_MODELS);
/** One harness's models; with several harnesses, each in its own group (the server checks the pair). */
export const modelSelect = (current = "", harnesses: HarnessId[] = ["claude"]) =>
  html`<label class="field"><span class="label">Model</span><select name="model">${
    harnesses.length === 1
      ? options(modelsFor(harnesses[0]), current)
      : harnesses.map((h) => html`<optgroup label="${HARNESS_LABEL[h]}">${options(modelsFor(h), current)}</optgroup>`)
  }</select></label>`;
