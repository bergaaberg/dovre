/**
 * My avatar, a core pack (PLAN WP-X2): a creature I pick, shaped by what I do on GHE and set in a
 * scene by how things are. It shows in two core places through slots (Today's header, the Bino
 * button and Bino's header) and has its own page (/avatar). How things are comes from the snapshot,
 * My list and what the other packs tell it (their `avatar` hook: what works and waits, what's
 * wrong, whether I'm on duty), all counts.
 */
import { needsOf } from "../../../home/needs.ts";
import { listTodos } from "../../../todo/store.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import type { AvatarFeeds } from "../../registry.ts";
import { type Pack, PACK_API, type PackContext } from "../../types.ts";
import { type Avatar, createAvatar } from "./avatar.ts";
import { signalsFrom } from "./feed.ts";
import { type AvatarData, createAvatarData } from "./stats.ts";
import { AVATAR_CSS, AVATAR_PAGE_CSS } from "./style.ts";
import { avatarDock, avatarHero, avatarMini, avatarRoutes } from "./view.ts";

export type AvatarDeps = {
  /** What works for me and waits on me across the packs, and whether anything has it at work (Bino answering). */
  feeds: () => AvatarFeeds & { busy: boolean };
  /** GHE, for the numbers that shape it: without it, it keeps its starting shape. */
  ghe?: { ghe: Ghe; org: string; login: () => string | undefined };
  /** The idle picture whenever it changes (here: a copy for the starting page). */
  onStart?: (svg: string) => void;
  now?: () => number;
};

const osloHour = (t: number) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", hourCycle: "h23" }).format(t));

export function avatarPack(o: AvatarDeps): Pack {
  const clock = o.now ?? Date.now;
  let ctx: PackContext | undefined;
  /** My list: items I'm doing (read on refresh). */
  let doing = 0;
  let shown = "";
  const data: AvatarData | undefined = o.ghe ? createAvatarData({ ...o.ghe, now: clock, onChange: () => ctx?.publish(["avatar"]), log: (l) => ctx?.log(l) }) : undefined;
  const avatar: Avatar = createAvatar({
    data,
    onStart: o.onStart,
    now: clock,
    busy: () => o.feeds().busy,
    signals: () => {
      const s = ctx?.snapshot();
      if (!s) return undefined;
      return signalsFrom({ snap: s, needs: needsOf(s), feeds: o.feeds(), doing, mergedToday: 0, hour: osloHour(clock()) });
    },
  });
  return {
    manifest: {
      api: PACK_API,
      id: "avatar",
      name: "Avatar",
      description: "Me in Dovre: a creature shaped by what I do on GHE, in a scene set by how things are",
      domain: "general",
      execution: "any",
      everyMs: 60_000,
    },
    styles: AVATAR_PAGE_CSS + AVATAR_CSS,
    async init(c) {
      ctx = c;
      await Promise.all([avatar.load(c.db), data?.load(c.db)]);
    },
    async refresh(c) {
      ctx = c;
      try {
        doing = (await listTodos(c.db)).filter((t) => t.state === "doing" && !t.parent).length;
      } catch {}
      await data?.refresh(c.db);
      // Open pages ask /avatar/now on every change; this covers what changes on its own (the hour, My list).
      const key = avatar.now().key;
      if (shown && key !== shown) c.publish(["avatar"]);
      shown = key;
    },
    pages: () => [{ title: "Your avatar", href: "/avatar", icon: "◉", about: "Pick a creature and its colours; what you do shapes the rest", also: ["avatar", "creature", "look"] }],
    slots: () => ({
      "today.hero": () => avatarHero(avatar.now(), avatar.today()),
      "bino.face": ({ place, thinking }) => (place === "dock" ? avatarDock(avatar.now()) : avatarMini(avatar.now(), thinking)),
    }),
    routes: (app, c) => avatarRoutes(app, c, avatar),
  };
}
