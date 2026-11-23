// Loaded with `nomodule`, so only browsers without ES-module support (IE11)
// execute it. Conditional comments stopped working in IE10+, so this is how
// the IE-only stylesheet still gets loaded without penalising modern browsers.
(function () {
    const doc = document as Document & { documentMode?: number };
    if (!doc.documentMode) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/css/ie.css";
    document.head.appendChild(link);
})();
