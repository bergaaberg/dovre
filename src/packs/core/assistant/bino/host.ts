/**
 * What core hands its own assistant pack (#391): Bino's engine, which core runs beside the gather
 * and the other packs, and what Bino's pages read from the rest of Dovre. Only the core pack with
 * id `assistant` gets one (src/app.ts); any other pack, and the assistant pack with Bino off, gets
 * none, and then mounts no Bino pages.
 */
import type { Pack } from "../../../types.ts";
import type { PackAct } from "../../../registry.ts";
import type { Bino } from "./bino.ts";
import type { DockAssets } from "./routes.ts";
import type { ViewApp } from "./view.ts";
import type { Frame } from "../../../../html.ts";

export type AssistantHost = {
  bino: Bino;
  /** The shell's frame for a page of Bino's. */
  frame(): Promise<Frame>;
  /** The org a bare repo name in a dev task card is under. */
  org: string;
  /** The packs on here: a conversation started on one of their pages is about that app. */
  apps(): ViewApp[];
  /** A pack's act by its kind, when that pack is on. */
  packAct(kind: string): PackAct | undefined;
  /** What Bino knows now, sent with each message when Bino answers elsewhere (hosted: the Durable Object). */
  context?: () => Promise<string>;
  /** The packs' stylesheet and scripts, which the pane loads like a pack's dock page. */
  assets: DockAssets;
};

const hosts = new WeakMap<Pack, AssistantHost>();

/** Core gives its assistant pack Bino, before the pack's routes are mounted. */
export function hostAssistant(pack: Pack, host: AssistantHost): void {
  hosts.set(pack, host);
}

export const assistantHostOf = (pack: Pack): AssistantHost | undefined => hosts.get(pack);
