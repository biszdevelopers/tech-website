// Mobile sidebar toggle + dropdown behaviour (dashboard chrome).
function initDashMenu(): void {
    const toggler = document.querySelector<HTMLElement>(".nav-toggler");
    const sidebar = document.querySelector<HTMLElement>(".left-sidebar");

    if (toggler && sidebar) {
        toggler.addEventListener("click", function (e: Event) {
            e.preventDefault();
            sidebar.classList.toggle("open");
        });
    }

    const links = document.querySelectorAll(".sidebar-link");
    Array.prototype.forEach.call(links, function (link: Element) {
        link.addEventListener("click", function () {
            if (window.innerWidth < 880 && sidebar) sidebar.classList.remove("open");
        });
        // Mark the current section so the sidebar shows where you are.
        const href = link.getAttribute("href") || "";
        const here = window.location.pathname;
        if (href === here || (href !== "/web" && here.indexOf(href + "/") === 0)) {
            const item = link.closest(".sidebar-item");
            if (item) item.classList.add("active");
        }
    });

    const togglers = document.querySelectorAll('[data-toggle="dropdown"]');
    Array.prototype.forEach.call(togglers, function (el: Element) {
        el.addEventListener("click", function (e: Event) {
            e.preventDefault();
            const parent = el.closest(".dropdown");
            if (!parent) return;
            const menu = parent.querySelector<HTMLElement>(".dropdown-menu");
            if (!menu) return;
            const open = menu.style.display === "block";
            menu.style.display = open ? "none" : "block";
            if (!open) {
                // Pass the nodes as args: IE11-safe setTimeout + no re-narrow.
                setTimeout(registerOutsideClose, 0, parent, menu);
            }
        });
    });

    function registerOutsideClose(dropdown: Element, panel: HTMLElement): void {
        function close(ev: Event): void {
            if (!dropdown.contains(ev.target as Node)) {
                panel.style.display = "none";
                document.removeEventListener("click", close);
            }
        }
        document.addEventListener("click", close);
    }
}

initDashMenu();
