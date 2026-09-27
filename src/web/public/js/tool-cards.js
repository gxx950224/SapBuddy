/**
 * Tool chip adapter. A single React record keyed by toolCallId receives the
 * call arguments, terminal status, result and elapsed time from the pi events.
 */
"use strict";

(function() {
  const App = window.SapBuddy;

  App.summarizeArgs = function(args) {
    if (!args || typeof args !== "object") return "";
    return Object.entries(args).slice(0, 3).map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return key + ": " + String(text || "").replace(/\s+/g, " ").slice(0, 72);
    }).join(" · ");
  };

  App.enforceToolCollapse = function() {};
})();
