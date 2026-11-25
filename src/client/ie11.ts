/**
 * IE11 POLYFILLS - loaded synchronously via a conditional comment, before
 * every deferred app script. Only IE executes this file; modern browsers
 * treat the conditional comment as an ordinary comment.
 *
 * Provides Element.prototype.matches / .closest when missing.
 * The app only ever queries CLASS selectors through closest(), so the last
 * resort matcher below handles classes and plain tag names - plenty for this
 * codebase, and honest about its scope.
 */

const ie11Proto = Element.prototype as any;

function ie11MatchesByClass(el: Element, selector: string): boolean {
    // Supports ".class", "tag", and "tag.class" - all we use.
    const dotAt = selector.indexOf(".");
    if (dotAt === -1) {
        return el.tagName.toLowerCase() === selector.toLowerCase();
    }
    const tag = dotAt === 0 ? "" : selector.slice(0, dotAt);
    const className = selector.slice(dotAt + 1);
    const tagOk = tag === "" || el.tagName.toLowerCase() === tag.toLowerCase();
    return tagOk && el.classList.contains(className);
}

if (typeof ie11Proto.matches !== "function") {
    ie11Proto.matches = function (selectors: string): boolean {
        const native = this.msMatchesSelector || this.webkitMatchesSelector;
        if (typeof native === "function") return native.call(this, selectors);
        return ie11MatchesByClass(this, selectors);
    };
}

if (typeof ie11Proto.closest !== "function") {
    ie11Proto.closest = function (this: Element, selectors: string): Element | null {
        // Walk up the tree; the this-value is rebound per call, so the
        // alias below is the loop cursor.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let el: Element | null = this;
        while (el && el.nodeType === 1) {
            if (ie11Proto.matches.call(el, selectors)) return el;
            el = el.parentElement;
        }
        return null;
    };
}

// querySelectorAll results lack forEach in IE11 - borrow the Array one so
// no future call site can crash on it.
const nodeListCtor = window.NodeList as unknown as {
    prototype: Record<string, unknown>;
};
if (nodeListCtor && typeof nodeListCtor.prototype.forEach !== "function") {
    nodeListCtor.prototype.forEach = Array.prototype.forEach;
}

/**
 * IE11 ignores loading="lazy", so a long tool list downloads every screenshot
 * before the visitor scrolls. Swap far-below images for a 1px placeholder and
 * restore each source when it comes within one screen of the viewport.
 * JavaScript-disabled IE keeps its normal eager images because nothing runs.
 */
function ieLazyImages(): void {
    const images = document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]');
    if (images.length === 0) return;
    const pending: HTMLImageElement[] = [];
    const placeholder =
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    Array.prototype.forEach.call(images, function (img: HTMLImageElement) {
        const src = img.getAttribute("src");
        if (!src) return;
        // Keep images already near the first screen eager; only defer the rest.
        if (img.getBoundingClientRect().top < window.innerHeight + 500) return;
        img.setAttribute("data-ie-src", src);
        img.setAttribute("src", placeholder);
        pending.push(img);
    });
    if (pending.length === 0) return;

    let scheduled = false;
    function loadNearby(): void {
        scheduled = false;
        const limit = window.innerHeight + 500;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
            const img = pending[index];
            if (img.getBoundingClientRect().top >= limit) continue;
            const src = img.getAttribute("data-ie-src");
            if (src) img.setAttribute("src", src);
            img.removeAttribute("data-ie-src");
            pending.splice(index, 1);
        }
    }
    function schedule(): void {
        if (scheduled) return;
        scheduled = true;
        window.setTimeout(loadNearby, 120);
    }

    window.addEventListener("scroll", schedule, false);
    window.addEventListener("resize", schedule, false);
    window.addEventListener("load", loadNearby, false);
    loadNearby();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ieLazyImages, false);
} else {
    ieLazyImages();
}
