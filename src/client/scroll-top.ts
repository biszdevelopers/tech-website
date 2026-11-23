// Scroll-to-top button show/hide + smooth scroll.
function initScrollTop(): void {
    const btn =
        document.getElementById("topbutton") ??
        (document.querySelector(".scroll-top") as HTMLElement | null);
    if (!btn) return;
    const bar = document.getElementById("bar");
    const threshold = bar ? bar.offsetTop : 240;

    window.addEventListener("scroll", function () {
        const y = document.body.scrollTop || document.documentElement.scrollTop || 0;
        btn.style.display = y > threshold ? "block" : "none";
    });
    btn.addEventListener("click", function () {
        if ("scrollBehavior" in document.documentElement.style) {
            window.scrollTo({ top: 0, behavior: "smooth" });
        } else {
            window.scrollTo(0, 0);
        }
    });
}

initScrollTop();
