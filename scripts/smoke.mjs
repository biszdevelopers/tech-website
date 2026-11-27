// Production smoke test. Run against a booted server:
//   BASE=https://example.com SMOKE_ADMIN_PASSWORD=... node scripts/smoke.mjs
// Exits non-zero if any check fails.
try {
    process.loadEnvFile();
} catch {
    /* real env wins */
}
const BASE = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;
const USER = process.env.SMOKE_ADMIN_USERNAME || process.env.ADMIN_USERNAME || "admin";
const PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "";

let failures = 0;
function check(name, pass, detail = "") {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
    if (!pass) failures += 1;
}

async function pageToken(path) {
    const res = await fetch(BASE + path);
    const html = await res.text();
    const token = (html.match(/name="csrf-token" content="([^"]+)"/) ?? [])[1] ?? "";
    const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
    return { token, cookies, html };
}

async function main() {
    const health = await fetch(`${BASE}/api/health`);
    check("health endpoint", health.status === 200);

    const home = await fetch(`${BASE}/`);
    check("home renders", home.status === 200 && (await home.text()).includes("Tech Tools"));
    check("tl1 renders", (await fetch(`${BASE}/tl1`)).status === 200);

    // Portal routes are indistinguishable from a missing page.
    const probe = await pageToken("/login");
    const anon = await fetch(`${BASE}/api/admin/accept`, {
        method: "POST",
        headers: {
            Origin: BASE,
            "Content-Type": "application/json",
            "x-csrf-token": probe.token,
            Cookie: probe.cookies.join("; "),
        },
        body: JSON.stringify({ id: 1 }),
    });
    check("main admin API hidden when anonymous", anon.status === 404, String(anon.status));
    check(
        "web admin page hidden when anonymous",
        (await fetch(`${BASE}/web/admin/dashboard`)).status === 404
    );

    // CSRF: cross-origin refused; same-origin without a token refused.
    const evil = await fetch(`${BASE}/api/submission`, {
        method: "POST",
        headers: { Origin: "http://evil.example" },
        body: new URLSearchParams({ techname: "x", link: "x", displaytext: "x" }),
    });
    check("cross-origin POST blocked", evil.status === 403, String(evil.status));
    const noToken = await fetch(`${BASE}/api/submission`, {
        method: "POST",
        headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
        body: "techname=x&link=x&displaytext=x",
    });
    check("POST without token blocked", noToken.status === 403, String(noToken.status));

    // Login requires the token from a real page.
    const login = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        redirect: "manual",
        headers: {
            Origin: BASE,
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: probe.cookies.join("; "),
        },
        body: `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASSWORD)}&_csrf=${probe.token}`,
    });
    const sessionCookies = [
        ...probe.cookies,
        ...(login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]),
    ];
    const cookie = sessionCookies.join("; ");
    check("login redirects", [302, 303, 307, 308].includes(login.status), String(login.status));
    check("login issues session cookie", sessionCookies.length > 0);

    if (PASSWORD && cookie) {
        const adminPage = await fetch(`${BASE}/admin`, { headers: { Cookie: cookie } });
        const adminHtml = await adminPage.text();
        const adminToken = (adminHtml.match(/name="csrf-token" content="([^"]+)"/) ?? [])[1] ?? "";
        check("admin page reachable with session", adminPage.status === 200);
        const ok = await fetch(`${BASE}/api/admin/delete`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: cookie,
                Origin: BASE,
                "x-csrf-token": adminToken,
            },
            body: JSON.stringify({ id: 0 }),
        });
        check("authed admin API reachable", ok.status === 400, String(ok.status));
    } else if (!PASSWORD) {
        console.log("SKIP  admin session checks (SMOKE_ADMIN_PASSWORD not set)");
    }

    // Rate limit still fires after the CSRF gate.
    let got429 = false;
    for (let i = 0; i < 12; i += 1) {
        const res = await fetch(`${BASE}/api/auth/login`, {
            method: "POST",
            headers: {
                Origin: BASE,
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                Cookie: probe.cookies.join("; "),
            },
            body: `username=nobody&password=wrong&_csrf=${probe.token}`,
        });
        if (res.status === 429) {
            got429 = true;
            break;
        }
    }
    check("login rate limit returns 429", got429);

    // Crawler files.
    const robots = await fetch(`${BASE}/robots.txt`);
    const robotsBody = await robots.text();
    check(
        "robots.txt served without portal hints",
        robots.status === 200 && !/admin|\/login/i.test(robotsBody)
    );
    const sitemap = await fetch(`${BASE}/sitemap.xml`);
    const sitemapBody = await sitemap.text();
    check(
        "sitemap.xml valid",
        sitemap.status === 200 &&
            /<urlset[\s>]/.test(sitemapBody) &&
            !/admin|\/login/.test(sitemapBody),
        `${sitemap.status}, ${sitemapBody.length} bytes`
    );

    if (failures > 0) {
        console.error(`\n${failures} check(s) FAILED`);
        process.exit(1);
    }
    console.log("\nAll smoke checks passed.");
}

main().catch((e) => {
    console.error("Smoke test crashed:", e);
    process.exit(1);
});
