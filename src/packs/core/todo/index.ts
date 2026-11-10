/**
 * My list, a core pack (#393): small things and small initiatives that live nowhere else, kept in
 * this machine's database (store.ts), at /todo with a card on Today. It shares the list (`list`)
 * with what reads or adds to it: Bino's context and its plans, search, New work's "Also put it on
 * My list". Hosted it runs too, off the menu.
 */
import { type ListShare, type Pack, type PackContext, PACK_API } from "../../types.ts";
import { addTodo, getTodo, listTodos } from "./store.ts";
import { linkCtxOf, mountTodo, todoCard } from "./view.ts";

const TODO_PACK_ID = "todo";
const HREF = "/todo";

type TodoDeps = {
  /** Where a PR or issue reference links to: the forge's host and the owner a bare `repo#12` is in. */
  links: () => { ghe: string; org: string };
  /** Bino can answer now: the list offers talking a task through. */
  bino?: () => boolean;
  now?: () => number;
};

export function todoPack(o: TodoDeps): Pack {
  const now = o.now ?? Date.now;
  const changed = (ctx: PackContext) => ctx.publish([TODO_PACK_ID]);
  return {
    manifest: {
      api: PACK_API,
      id: TODO_PACK_ID,
      name: "My list",
      description: "Small things and small initiatives that live nowhere else, with dates",
      domain: "personal",
      roles: ["po", "an"],
      answers: ["tasks:head"],
      // Its items link to agent sessions and start agents while that pack is on (#394).
      uses: ["agents"],
    },
    writes: [{ kind: "delete", label: "Delete from My list" }],
    routes: (app, ctx) => mountTodo(app, { ctx, links: o.links, bino: o.bino, now, changed: () => changed(ctx) }),
    nav: (ctx) => (ctx.hosted ? [] : [{ href: HREF, title: "My list", icon: "list", group: "Plan" }]),
    pages: () => [
      { title: "My list", href: HREF, icon: "☐", about: "Your own list, with dates", also: ["todo", "tasks", "liste", "huskeliste"] },
    ],
    finds: () => [{ title: "Add to My list", icon: "☐", href: `${HREF}?add`, also: ["todo", "remember", "husk"], kind: "actions" }],
    today: async (ctx) => [{ id: "list", column: "left", order: 30, render: todoCard(await listTodos(ctx.db), linkCtxOf(o.links(), ctx.snapshot(), ctx.refs(), ctx.required("agents", "agent")), now()) }],
    shares: (ctx): { list: ListShare } => ({
      list: {
        items: () => listTodos(ctx.db),
        get: (id) => getTodo(ctx.db, id),
        add: async (t) => {
          const item = await addTodo(ctx.db, t, now());
          if (item) changed(ctx);
          return item;
        },
        href: (id) => `${HREF}#t-${id}`,
      },
    }),
  };
}
