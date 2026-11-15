/**
 * Blocking boot script: applies the saved/OS theme before first paint so
 * IPstress (dark by default) does not flash for OS-light visitors.
 * ES5 so IE11 can run it; loaded synchronously from <head>.
 */
(function () {
    try {
        const cookie = /(?:^|;\s*)theme=([^;]+)/.exec(document.cookie);
        let saved = cookie ? decodeURIComponent(cookie[1]) : null;
        if (!saved) saved = localStorage.getItem("theme");
        if (!saved && window.matchMedia) {
            saved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
        if (saved === "dark" || saved === "light") {
            document.documentElement.setAttribute("data-theme", saved);
        }
    } catch {
        /* storage blocked: keep the server-rendered/default theme */
    }
})();
