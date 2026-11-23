// Image fallback: swap broken <img> tags to an inline placeholder.
const FALLBACK_IMAGE =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23eee'/%3E%3C/svg%3E";

const brokenImages = document.querySelectorAll<HTMLImageElement>("img[data-fallback]");
Array.prototype.forEach.call(brokenImages, function (img: HTMLImageElement) {
    function swap(): void {
        img.src = FALLBACK_IMAGE;
    }
    img.addEventListener("error", swap);
    // Errors that fired before this deferred script ran never reach the handler.
    if (img.complete && img.naturalWidth === 0) swap();
});
