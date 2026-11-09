/**
 * A pack's setup page (src/pages/setup.ts, #441), its one script: a step with `refresh` draws itself
 * again in place (no reload, no jump to the top), and a step with `carry` presses its main button
 * again by itself, and a step's list of ticks (.su-filter, #447) filters in place, with None and
 * "All with issues". Without script the page still works: a <noscript> refresh, the button, the whole list.
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
    Array.prototype.forEach.call(c.querySelectorAll(".su-filter[hidden]"), function (f) { f.hidden = false; });
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
  // Delegated, so a step drawn again in place keeps them.
  document.addEventListener("input", function (e) {
    var box = e.target;
    if (!box.matches || !box.matches(".su-find")) return;
    var body = box.closest(".su-body");
    var q = box.value.trim().toLowerCase();
    Array.prototype.forEach.call(body.querySelectorAll(".check-row"), function (r) { r.hidden = !!q && r.textContent.toLowerCase().indexOf(q) < 0; });
    Array.prototype.forEach.call(body.querySelectorAll("details"), function (d) { if (q) d.open = true; });
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-pick]");
    if (!b) return;
    var hot = b.getAttribute("data-pick") === "hot";
    Array.prototype.forEach.call(b.closest(".su-body").querySelectorAll(".check-row"), function (r) {
      var box = r.querySelector("input[type=checkbox]");
      if (box) box.checked = hot && !!r.closest("[data-hot]") && !!r.querySelector("small");
    });
  });
  tick();
})();
`;
export const SETUP_JS_PATH = `/assets/setup.${hashOf(SETUP_JS)}.js`;
