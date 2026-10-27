/**
 * Line icons, 24-unit grid, drawn in currentColor. Each page carries them once (SPRITE, in the
 * shell) and every icon() is a reference to one. Constants only: the raw() here wraps nothing else.
 */
import { raw } from "hono/html";

const PATHS = {
  brand: `<path d="m2.5 20 6.5-11.5 4 6.5 2.5-4 6 9z"/><path d="m7.2 11.6 1.8 1.4 1.6-1.2"/>`,
  home: `<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/>`,
  inbox: `<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  chart: `<path d="M3 3v18h18"/><path d="M7.5 17v-4M12 17V9M16.5 17V6"/>`,
  health: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  contours: `<path d="M2.5 19c2.2-3.3 5.4-5 9.5-5s7.3 1.7 9.5 5"/><path d="M6 14.5c1.6-2.8 3.6-4.2 6-4.2s4.4 1.4 6 4.2"/><path d="M9.5 9.8c.8-1.8 1.6-2.8 2.5-2.8s1.7 1 2.5 2.8"/>`,
  pen: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>`,
  agents: `<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="m7 10 3 2.5L7 15"/><path d="M12.5 15H17"/>`,
  tasks: `<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5"/><path d="m3.5 12 1.5 1.5L7.5 11"/><circle cx="5" cy="18" r="1.5"/>`,
  menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,
  alert: `<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  error: `<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5"/><path d="M12 16.5h.01"/>`,
  ok: `<circle cx="12" cy="12" r="9.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>`,
  info: `<circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5"/><path d="M12 7.5h.01"/>`,
  mail: `<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="m21.5 7-9.5 6.5L2.5 7"/>`,
  reply: `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5V20"/>`,
  branch: `<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="7.5" r="2.5"/><path d="M6 8v8"/><path d="M18 10c0 4.5-6.5 3.5-10.5 6.8"/>`,
  external: `<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H11"/>`,
  archive: `<rect x="2.5" y="3.5" width="19" height="5" rx="1"/><path d="M4.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8.5"/><path d="M10 12.5h4"/>`,
  clip: `<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>`,
  shield: `<path d="M12 21.5s7.5-3.6 7.5-9.5V5.5L12 2.5l-7.5 3V12c0 5.9 7.5 9.5 7.5 9.5z"/><path d="m9 12 2.2 2.2L15.5 10"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  download: `<path d="M12 3.5v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20.5h16"/>`,
  arrow: `<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>`,
  chat: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  compass: `<circle cx="12" cy="12" r="9.5"/><polygon points="16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9 16.2 7.8"/>`,
  pr: `<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M6 8v8"/><path d="M18 16V9.5a3 3 0 0 0-3-3h-4"/><path d="m13 4-2.5 2.5L13 9"/>`,
  rocket: `<path d="M12 15.5 8.5 12c1.2-4.8 4.2-8.2 10.5-9-.8 6.3-4.2 9.3-9 10.5"/><path d="M8.5 12H5l2.5-4h4"/><path d="M12 15.5V19l4-2.5v-4"/><path d="M6 17c-1 1-1.5 3-1.5 3s2-.5 3-1.5"/>`,
  ticket: `<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12"/>`,
  people: `<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.5a6.5 6.5 0 0 1 3 5.5"/>`,
  // Bino's button without a pack's face: a Dovre peak with the sparkle people read as "an AI assistant" over it.
  bino: `<path d="M2.5 20.5 9 9.5l4 6.5 2.5-3.5 6 8z"/><path d="m7.1 12.8 1.9 1.5 1.7-1.3"/><path d="M17 2c.4 2.4 1.1 3.1 3.5 3.5-2.4.4-3.1 1.1-3.5 3.5-.4-2.4-1.1-3.1-3.5-3.5 2.4-.4 3.1-1.1 3.5-3.5z"/><path d="M5 3.5c.2 1 .5 1.3 1.5 1.5-1 .2-1.3.5-1.5 1.5-.2-1-.5-1.3-1.5-1.5 1-.2 1.3-.5 1.5-1.5z"/>`,
  spark: `<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6.3 6.3 2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  code: `<path d="m8.5 7-5 5 5 5"/><path d="m15.5 7 5 5-5 5"/>`,
  layers: `<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>`,
  db: `<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`,
  gear: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  flask: `<path d="M9 3h6"/><path d="M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9.5V3"/><path d="M7 15h10"/>`,
  refresh: `<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20.5V16h-4.5"/>`,
  fold: `<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>`,
  list: `<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>`,
  box: `<path d="m12 2.5 8.5 4.5v10L12 21.5 3.5 17V7z"/><path d="m3.5 7 8.5 4.5L20.5 7"/><path d="M12 11.5v10"/>`,
} as const;

export type IconName = keyof typeof PATHS;

/** Every icon as a <symbol>, once per page (the shell puts it first in <body>). */
export const SPRITE = raw(
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${Object.entries(PATHS)
    .map(([name, paths]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${paths}</symbol>`)
    .join("")}</svg>`,
);

const NAMES = new Set(Object.keys(PATHS));

export function icon(name: IconName) {
  // The name is one of PATHS' keys (the type says so; this makes sure at run time too).
  if (!NAMES.has(name)) throw new Error(`no icon ${name}`);
  return raw(`<svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-${name}"/></svg>`);
}
