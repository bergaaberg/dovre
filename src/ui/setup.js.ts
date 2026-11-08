/**
 * A pack's setup page (src/pages/setup.ts, #441), its one script: a step with `refresh` draws itself
 * again in place (no reload, no jump to the top), and a step with `carry` presses its main button
 * again by itself. Without script the page still works: a <noscript> refresh, and the button.
 */
import { hashOf } from "./style.ts";

export const SETUP_JS = String.raw`(function () {
  "use strict";
  // The carry last pressed: the same one drawn again after a press made no headway, so stop and leave the button.
  var pressed = "";
  var timer = 0;
  var col = function () { return document.querySelector(".climb-col"); };
  function swap(text) {
    var next = new DOMParser().parseFromString(text, "text/html").querySelector(".climb-col");
    var now = col();
    if (next && now) now.replaceWith(document.importNode(next, true));
    tick();
  }
  function fetchSwap(url, init) {
    return fetch(url, init).then(function (r) {
      if (!r.ok && r.status !== 422 && r.status !== 500) throw new Error(String(r.status));
      return r.text();
    }).then(swap, function () { timer = setTimeout(redraw, 10000); });
  }
  function redraw() {
    if (document.hidden) { timer = setTimeout(redraw, 2000); return; }
    fetchSwap(location.href, { credentials: "same-origin" });
  }
  function tick() {
    clearTimeout(timer);
    var c = col();
    if (!c) return;
    var go = c.querySelector("[data-carry]");
    var form = go && go.querySelector("form");
    if (form && go.getAttribute("data-carry") !== pressed) {
      pressed = go.getAttribute("data-carry");
      // Followed to the step it redirects back to: that answer is the step drawn again.
      fetchSwap(form.action, { method: "POST", credentials: "same-origin", body: new URLSearchParams(new FormData(form)) });
      return;
    }
    var n = Number(c.getAttribute("data-refresh") || 0);
    if (n > 0) timer = setTimeout(redraw, n * 1000);
  }
  tick();
})();
`;
export const SETUP_JS_PATH = `/assets/setup.${hashOf(SETUP_JS)}.js`;
