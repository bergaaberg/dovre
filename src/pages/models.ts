/** The pickers for an agent turn (new sessions, replies, agent reviews): mode, model, effort, each as the harness declares it (#236). */
import { html } from "hono/html";
import { modelsOf as modelsFor, optionsOf } from "../agents/harnesses/index.ts";
import { type HarnessId, MODES } from "../agents/runner.ts";
import { HARNESS_NAME } from "./parts.ts";

export const HARNESS_LABEL: Record<HarnessId, string> = HARNESS_NAME;

/** A mode in a few words, as this harness names it. */
export const modeShort = (mode: string, h: HarnessId = "claude") => optionsOf(h).modes[mode as (typeof MODES)[number]]?.short ?? mode;

export const modeSelect = (current = "default", h: HarnessId = "claude") => {
  const names = optionsOf(h).modes;
  return html`<label class="field"><span class="label">Mode</span><select name="mode">${MODES.map((m) => html`<option value="${m}"${m === current ? html` selected` : ""}>${names[m].label}</option>`)}</select></label>`;
};
const options = (list: { value: string; label: string }[], current: string | null) => list.map((m) => html`<option value="${m.value}"${m.value === current ? html` selected` : ""}>${m.label}</option>`);
/** One harness's models; with several harnesses, each in its own group (the server checks the pair). */
export const modelSelect = (current = "", harnesses: HarnessId[] = ["claude"]) =>
  html`<label class="field"><span class="label">Model</span><select name="model">${
    harnesses.length === 1
      ? options(modelsFor(harnesses[0]), current)
      : // Every group has a default (""): only the first is picked, else the browser shows the last group's.
        harnesses.map((h, i) => html`<optgroup label="${HARNESS_LABEL[h]}">${options(modelsFor(h), current === "" && i > 0 ? null : current)}</optgroup>`)
  }</select></label>`;

/** The harness's effort levels, when it takes any. */
export const effortSelect = (current = "", h: HarnessId = "claude") => {
  const list = optionsOf(h).efforts;
  return list.length ? html`<label class="field"><span class="label">Effort</span><select name="effort">${options(list, list.some((c) => c.value === current) ? current : "")}</select></label>` : "";
};

/** Everything a turn in this harness may pick, and nothing it doesn't take. */
export const turnFields = (h: HarnessId, cur: { mode?: string; model?: string; effort?: string } = {}) => html`${modeSelect(cur.mode, h)}${modelSelect(cur.model ?? "", [h])}${effortSelect(cur.effort, h)}`;

/**
 * The new-session form's options, one set per harness: the one picked shows, the rest are hidden
 * and disabled, so only its fields are sent. The page's script swaps them when the Agent changes.
 */
export const harnessFields = (harnesses: HarnessId[]) =>
  harnesses.length === 1
    ? turnFields(harnesses[0]!)
    : harnesses.map((h, i) => html`<fieldset class="harness-opts" data-harness="${h}"${i ? html` hidden disabled` : ""}><legend class="sr-only">${HARNESS_LABEL[h]}'s options</legend>${turnFields(h)}</fieldset>`);
