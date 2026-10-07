/*
  Runs inside an HTML note shown from a memory, in its sandboxed frame, before
  the note's body is parsed. It does only what a note cannot do for itself:

  - marks the root, so the ctx- components in notes.css apply
  - turns on the document style when the frame's address says ?style=basic
  - keeps a swipe past the end of the note inside the note
  - sends a link to another file in the same memory out to the page, which
    opens it as a tab, instead of navigating this frame out of step with the
    tabs and the address bar. A link off the site opens in a new tab.

  The frame has an origin of its own, so it has no storage and cannot reach the
  page: a message is the only way out, and it carries a path and nothing else.
*/
(function () {
  var root = document.documentElement;
  root.setAttribute("data-ctx-frame", "");
  var style = new URLSearchParams(location.search).get("style");
  if (style && style !== "none") root.setAttribute("data-doc-style", style);
  root.style.overscrollBehaviorY = "contain";

  if (window.parent === window) return;

  // /memory/<pass>/<path>: everything after the pass is a path in the memory.
  var parts = location.pathname.split("/");
  var prefix = "/" + parts[1] + "/" + parts[2] + "/";

  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest && event.target.closest("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    var href = link.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    var url = new URL(href, location.href);
    if (url.host === location.host && url.pathname.indexOf(prefix) === 0) {
      event.preventDefault();
      var path = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
      window.parent.postMessage({ type: "chloe:open", path: path }, location.origin);
      return;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
})();
