const konami = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65];
let position = 0;
let toastTimer: number | null = null;

function once(key: string): boolean {
    try {
        if (sessionStorage.getItem(key)) return false;
        sessionStorage.setItem(key, "1");
        return true;
    } catch {
        return true;
    }
}

function toast(message: string): void {
    let node = document.getElementById("quiet-note");
    if (!node) {
        node = document.createElement("div");
        node.id = "quiet-note";
        node.setAttribute("role", "status");
        node.className = "quiet-note";
        document.body.appendChild(node);
    }
    node.textContent = message;
    node.className = "quiet-note quiet-note--on";
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    const current = node;
    toastTimer = window.setTimeout(function () {
        current.className = "quiet-note";
    }, 4200);
}

function spark(): void {
    document.body.className += " quiet-spark";
    window.setTimeout(function () {
        document.body.className = document.body.className.replace(/\s*quiet-spark/g, "");
    }, 2400);
}

if (once("quiet-console")) {
    try {
        console.log(
            "%cBIBS-C Tech Tools%c\nrichie-rich90454 wrote this. The quiet shelf is open.",
            "color:#0cf293;font:700 16px sans-serif",
            "color:#9aa8d0;font:12px sans-serif"
        );
    } catch {
        /* console can be unavailable */
    }
}

document.addEventListener("keydown", function (ev: KeyboardEvent) {
    const key = ev.keyCode || 0;
    if (key === konami[position]) {
        position += 1;
        if (position === konami.length) {
            position = 0;
            spark();
        }
    } else {
        position = key === konami[0] ? 1 : 0;
    }

    if (ev.altKey && ev.shiftKey && (key === 82 || key === 114)) {
        ev.preventDefault();
        toast("richie-rich90454 wrote this. You found the quiet shelf.");
    }
});

if (/^\/tool\/\d+/.test(window.location.pathname) && once("quiet-tool")) {
    try {
        console.log("First shelf, first tool. richie-rich90454 left the light on.");
    } catch {
        /* console can be unavailable */
    }
}
