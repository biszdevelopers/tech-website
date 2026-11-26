#!/usr/bin/env node
/**
 * End-to-end flow check against a throwaway copy of the databases and uploads.
 * Requires `pnpm run build`. Exits non-zero on the first broken flow.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const PORT = Number(process.env.FLOW_PORT ?? 3291);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = process.env.FLOW_ADMIN_PASSWORD ?? "admin12345";
const tmp = mkdtempSync(join(tmpdir(), "bibs-flows-"));
const uploads = join(tmp, "uploads");
const og = join(tmp, "og");
mkdirSync(uploads, { recursive: true });
mkdirSync(og, { recursive: true });

if (!existsSync(join(ROOT, "dist", "server.js"))) {
    console.error("dist/server.js not found. Run pnpm run build first.");
    process.exit(1);
}
for (const [from, to] of [
    ["data/main.db", join(tmp, "main.db")],
    ["data/web.db", join(tmp, "web.db")],
]) {
    if (!existsSync(join(ROOT, from))) {
        console.error(`${from} not found. Run pnpm run db:reset first.`);
        process.exit(1);
    }
    const source = new Database(join(ROOT, from), { readonly: true });
    await source.backup(to);
    source.close();
}
if (existsSync(join(ROOT, "var", "uploads"))) {
    cpSync(join(ROOT, "var", "uploads"), uploads, { recursive: true });
}

const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    SITE_ORIGIN: BASE,
    DATABASE_URL_MAIN: `file:${join(tmp, "main.db")}`,
    DATABASE_URL_WEB: `file:${join(tmp, "web.db")}`,
    UPLOADS_DIR: uploads,
    OG_DIR: og,
    SESSION_SECRET: "flow-secret-flow-secret-flow-secret-32!!",
    SESSION_SECRET_WEB: "flow-secret-web-flow-secret-web-32!!",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD,
    TRUST_PROXY: "false",
};

let child;
let failures = 0;
function check(name, value, detail = "") {
    if (value) {
        console.log(`PASS  ${name}${detail ? ` (${detail})` : ""}`);
    } else {
        failures += 1;
        console.error(`FAIL  ${name}${detail ? ` (${detail})` : ""}`);
    }
}

function token(html) {
    return (html.match(/meta name="csrf-token" content="([^"]+)"/) ?? [])[1] ?? "";
}
function cookies(response) {
    return (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";")[0]);
}
async function page(path, cookie = "") {
    const response = await fetch(BASE + path, {
        headers: cookie ? { cookie } : {},
        redirect: "manual",
    });
    return { response, html: await response.text() };
}
async function postForm(path, form, cookie, accept = "text/html") {
    return fetch(BASE + path, {
        method: "POST",
        redirect: "manual",
        headers: {
            Origin: BASE,
            Accept: accept,
            "Content-Type": "application/x-www-form-urlencoded",
            ...(cookie ? { cookie } : {}),
        },
        body: new URLSearchParams(form).toString(),
    });
}
async function login(kind) {
    const loginPath = kind === "main" ? "/login" : "/web/login";
    const action = kind === "main" ? "/api/auth/login" : "/web/api/auth/login";
    const first = await page(loginPath);
    const csrf = token(first.html);
    const jar = cookies(first.response);
    const response = await postForm(
        action,
        { username: "admin", password: ADMIN_PASSWORD, _csrf: csrf },
        jar.join("; ")
    );
    jar.push(...cookies(response));
    return { cookie: jar.join("; "), csrf, response };
}

async function main() {
    child = spawn(process.execPath, ["dist/server.js"], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk.toString()));
    child.stderr.on("data", (chunk) => (log += chunk.toString()));

    let ready = false;
    for (let i = 0; i < 80; i += 1) {
        try {
            const response = await fetch(`${BASE}/api/health`);
            if (response.ok) {
                ready = true;
                break;
            }
        } catch {
            /* still booting */
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready) {
        console.error("Server did not become ready.");
        console.error(log.slice(-4000));
        process.exit(1);
    }

    check("health", true);
    const home = await page("/");
    check("home renders", home.response.status === 200 && home.html.includes("Six Domains"));
    check("home one h1", (home.html.match(/<h1[\s>]/g) ?? []).length === 1);
    check("home canonical", /rel="canonical" href="http:\/\/127\.0\.0\.1:/.test(home.html));
    check("home og image", /property="og:image"/.test(home.html));
    for (const path of ["/tl1", "/tl5", "/tl6", "/tl1/relationships"]) {
        const result = await page(path);
        check(`${path} renders`, result.response.status === 200, String(result.response.status));
    }
    const tl5 = await page("/tl5");
    check("tl5 curated tools", tl5.html.includes("TEAMS") && tl5.html.includes("WEEBLY"));
    check("tl5 not empty", !tl5.html.includes("No tools here yet"));

    const head = await fetch(`${BASE}/tool/1`, { method: "HEAD" });
    check("HEAD dynamic route", head.status === 200);
    const proto = await page("/toString");
    check("prototype key is 404", proto.response.status === 404);

    const anonSub = await page("/submission");
    const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const staleForm = new FormData();
    staleForm.set("_csrf", "b".repeat(64));
    staleForm.set("techname", "Stale Flow Tool");
    staleForm.set("link", "https://example.com/stale");
    staleForm.set("displaytext", "Stale");
    staleForm.set("tl1_desc", "Stale description");
    staleForm.set("R", "true");
    const stale = await fetch(`${BASE}/api/submission`, {
        method: "POST",
        redirect: "manual",
        headers: {
            Origin: BASE,
            Accept: "text/html",
            cookie: cookies(anonSub.response).join("; "),
        },
        body: staleForm,
    });
    check(
        "expired form redirects to a fresh one",
        stale.status === 303 && stale.headers.get("location") === "/submission?error=csrf",
        `${stale.status} ${stale.headers.get("location") ?? ""}`
    );
    const stalePage = await page("/submission?error=csrf");
    check("expired form explains what happened", stalePage.html.includes("form expired"));
    check("submission has category filters", anonSub.html.includes('name="tl5_c1"'));
    const form = new FormData();
    form.set("_csrf", token(anonSub.html));
    form.set("techname", "Flow Temp Tool");
    form.set("link", "https://example.com/flow");
    form.set("displaytext", "Flow");
    form.set("tl1_desc", "Flow description");
    form.set("tl5_desc", "Flow growth");
    form.set("tl5_c1", "true");
    form.set("R", "true");
    form.set("resources", "Manual | https://example.com/flow-manual");
    form.set("screenshot", new Blob([png], { type: "image/png" }), "flow.png");
    const submitted = await fetch(`${BASE}/api/submission`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: BASE, cookie: cookies(anonSub.response).join("; ") },
        body: form,
    });
    check("submission accepted", submitted.status === 303, String(submitted.status));
    const mainDb = new Database(join(tmp, "main.db"));
    const pending = mainDb
        .prepare("select * from submission where techname = 'Flow Temp Tool'")
        .get();
    check("submission row exists", Boolean(pending));
    check("submission is pending", pending?.accepted === 0);
    const pendingImage = await fetch(`${BASE}/uploads/${pending.id}`);
    check("pending image is private", pendingImage.status === 404, String(pendingImage.status));

    const mainAdmin = await login("main");
    check(
        "main login",
        mainAdmin.response.status === 303 &&
            mainAdmin.response.headers.get("location") === "/admin",
        mainAdmin.response.headers.get("location") ?? ""
    );
    const adminPage = await page("/admin", mainAdmin.cookie);
    const adminToken = token(adminPage.html);
    check("admin page", adminPage.response.status === 200);
    check("admin has logout POST", adminPage.html.includes('action="/api/auth/logout"'));
    const pendingAsAdmin = await fetch(`${BASE}/uploads/${pending.id}`, {
        headers: { cookie: mainAdmin.cookie },
    });
    check("pending image visible to admin", pendingAsAdmin.status === 200);
    const accepted = await fetch(`${BASE}/api/admin/accept`, {
        method: "POST",
        headers: {
            Origin: BASE,
            cookie: mainAdmin.cookie,
            "Content-Type": "application/json",
            "x-csrf-token": adminToken,
        },
        body: JSON.stringify({ id: String(pending.id) }),
    });
    check("accept submission", accepted.status === 200, String(accepted.status));
    const publicTool = await fetch(`${BASE}/tool/${pending.id}`, { redirect: "follow" });
    const publicToolHtml = await publicTool.text();
    check("accepted tool page is public", publicTool.status === 200, String(publicTool.status));
    check("accepted tool page shows the name", publicToolHtml.includes("Flow Temp Tool"));
    check("accepted tool page shows resources", publicToolHtml.includes("flow-manual"));
    const searchPage = await page("/search?query=Flow+Temp");
    check("accepted tool appears in search", searchPage.html.includes("Flow Temp Tool"));
    const tl5Page = await page("/tl5");
    check(
        "tl5 exposes strand and category filters",
        tl5Page.html.includes("filters--writeup") && tl5Page.html.includes("Category")
    );
    check(
        "tl5 shows both TL5 and TL6 category groups",
        tl5Page.html.includes('name="cat_tl5_1"') &&
            tl5Page.html.includes('name="cat_tl6_1"') &&
            tl5Page.html.includes("Professional Growth") &&
            tl5Page.html.includes("Contribution to Workplace Positivity")
    );
    check("tl5 category matches", (await page("/tl5?cat_tl5_1=1")).html.includes("Flow Temp Tool"));
    check(
        "tl5 category excludes other topics",
        !(await page("/tl5?cat_tl5_2=1")).html.includes("Flow Temp Tool")
    );
    check(
        "tl5 TL6 category excludes uncategorized tools",
        !(await page("/tl5?cat_tl6_1=1")).html.includes("Flow Temp Tool")
    );
    check(
        "legacy category links still work",
        (await page("/tl5?cat_1=1")).html.includes("Flow Temp Tool")
    );
    check("tl5 strand matches", (await page("/tl5?st_R=1")).html.includes("Flow Temp Tool"));
    check(
        "tl5 strand excludes other strands",
        !(await page("/tl5?st_TP=1")).html.includes("Flow Temp Tool")
    );
    const tl6Page = await page("/tl6");
    check(
        "tl6 shows both category groups",
        tl6Page.html.includes('name="cat_tl5_1"') && tl6Page.html.includes('name="cat_tl6_1"')
    );
    const editPage = await page(`/admin/edit/${pending.id}`, mainAdmin.cookie);
    check(
        "admin edit keeps the Label | URL resource format",
        editPage.html.includes("Manual | https://example.com/flow-manual")
    );
    const sitemapAccepted = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
    check("sitemap lists the accepted tool", sitemapAccepted.includes(`/tool/${pending.id}/`));
    const canonical = await fetch(`${BASE}/tool/${pending.id}`, { redirect: "manual" });
    check("tool canonical redirect", canonical.status === 301);

    const csv = await fetch(`${BASE}/admin/export.csv`, {
        headers: { cookie: mainAdmin.cookie },
    });
    const csvBody = await csv.text();
    check("CSV export", csv.status === 200 && csvBody.includes("Flow Temp Tool"));
    check("CSV has resources column", csvBody.split(/\r?\n/)[0].includes("resources"));
    check(
        "CSV keeps the Label | URL resource format",
        csvBody.includes("Manual | https://example.com/flow-manual")
    );
    check("CSV no-store", csv.headers.get("cache-control") === "private, no-store");

    const badOrigin = await fetch(`${BASE}/api/admin/reject`, {
        method: "POST",
        headers: {
            Origin: "https://evil.example",
            cookie: mainAdmin.cookie,
            "Content-Type": "application/json",
            "x-csrf-token": adminToken,
        },
        body: JSON.stringify({ id: String(pending.id) }),
    });
    check("cross-origin blocked", badOrigin.status === 403, String(badOrigin.status));
    const noToken = await fetch(`${BASE}/api/admin/reject`, {
        method: "POST",
        headers: { Origin: BASE, cookie: mainAdmin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ id: String(pending.id) }),
    });
    check("missing token blocked", noToken.status === 403, String(noToken.status));

    const deleted = await fetch(`${BASE}/api/admin/delete`, {
        method: "POST",
        headers: {
            Origin: BASE,
            cookie: mainAdmin.cookie,
            "Content-Type": "application/json",
            "x-csrf-token": adminToken,
        },
        body: JSON.stringify({ id: String(pending.id) }),
    });
    check("delete submission", deleted.status === 200, String(deleted.status));
    check(
        "delete removes resources",
        !mainDb.prepare("select 1 from resources where submissionId = ?").get(pending.id)
    );

    const bulkPage = await page("/submission/import");
    check(
        "bulk import page renders",
        bulkPage.response.status === 200 && bulkPage.html.includes("/sample-submissions.csv")
    );
    const sample = await fetch(`${BASE}/sample-submissions.csv`);
    const sampleText = await sample.text();
    check(
        "sample CSV downloads as CSV",
        sample.status === 200 &&
            String(sample.headers.get("content-type") ?? "").includes("text/csv")
    );
    check("sample CSV resource format", sampleText.includes(" | https://"));

    const bulkEntries = [
        {
            techname: "Bulk Alpha",
            link: "https://example.com/bulk-alpha",
            displaytext: "Bulk Alpha",
            tl1_desc: "Bulk alpha description.",
            R: "true",
            tl5_categories: "Self-reflection",
            resources: "Manual | https://example.com/bulk-alpha-manual",
        },
        {
            techname: "Bulk Beta",
            link: "https://example.com/bulk-beta",
            displaytext: "Bulk Beta",
            tl6_desc: "Bulk beta write-up.",
            tl6_categories: "Communication, Collegiality",
        },
    ];
    const bulk = await fetch(`${BASE}/api/submission/bulk`, {
        method: "POST",
        headers: {
            Origin: BASE,
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-csrf-token": token(bulkPage.html),
            cookie: cookies(bulkPage.response).join("; "),
        },
        body: JSON.stringify({ entries: bulkEntries }),
    });
    const bulkJson = await bulk.json();
    check(
        "bulk import accepted",
        bulk.status === 200 && bulkJson.imported === 2 && Array.isArray(bulkJson.ids),
        String(bulk.status)
    );
    const bulkRows = mainDb
        .prepare(
            "select id, techname, tl5_tags, tl6_tags, accepted from submission where techname in ('Bulk Alpha', 'Bulk Beta') order by id"
        )
        .all();
    check(
        "bulk rows are pending",
        bulkRows.length === 2 && bulkRows.every((row) => row.accepted === 0)
    );
    check("bulk TL5 categories stored", bulkRows[0]?.tl5_tags === "Self-reflection");
    check("bulk TL6 categories stored", bulkRows[1]?.tl6_tags === "Communication, Collegiality");
    check(
        "bulk resources stored",
        Boolean(
            bulkRows[0] &&
            mainDb
                .prepare("select 1 from resources where submissionId = ? and label = ?")
                .get(bulkRows[0].id, "Manual")
        )
    );

    const firstBulkId =
        Array.isArray(bulkJson.ids) && bulkJson.ids.length > 0 ? bulkJson.ids[0] : 0;
    const shotForm = new FormData();
    shotForm.set("_csrf", token(bulkPage.html));
    shotForm.set("token", bulkJson.token);
    shotForm.set("id", String(firstBulkId));
    shotForm.set("screenshot", new Blob([png], { type: "image/png" }), "bulk.png");
    const shot = await fetch(`${BASE}/api/submission/screenshot`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: BASE, Accept: "text/html" },
        body: shotForm,
    });
    check("bulk screenshot upload", shot.status === 200, String(shot.status));
    check(
        "bulk pending image is private",
        (await fetch(`${BASE}/uploads/${firstBulkId}`)).status === 404
    );
    check(
        "bulk pending image visible to admin",
        (
            await fetch(`${BASE}/uploads/${firstBulkId}`, {
                headers: { cookie: mainAdmin.cookie },
            })
        ).status === 200
    );

    const badTokenForm = new FormData();
    badTokenForm.set("_csrf", token(bulkPage.html));
    badTokenForm.set("token", "b".repeat(64));
    badTokenForm.set("id", String(firstBulkId));
    badTokenForm.set("screenshot", new Blob([png], { type: "image/png" }), "bad.png");
    check(
        "bulk screenshot rejects a bad token",
        (
            await fetch(`${BASE}/api/submission/screenshot`, {
                method: "POST",
                redirect: "manual",
                headers: { Origin: BASE, Accept: "text/html" },
                body: badTokenForm,
            })
        ).status === 403
    );

    const manyEntries = Array.from({ length: 30 }, (_, index) => ({
        techname: `Bulk Limit ${index}`,
        link: `https://example.com/bulk-limit-${index}`,
        displaytext: "Bulk Limit",
        tl1_desc: "Bulk limit description.",
        R: "true",
    }));
    const limited = await fetch(`${BASE}/api/submission/bulk`, {
        method: "POST",
        headers: {
            Origin: BASE,
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-csrf-token": token(bulkPage.html),
        },
        body: JSON.stringify({ entries: manyEntries }),
    });
    check("bulk rate limit counts entries", limited.status === 429, String(limited.status));

    mainDb.close();

    const seo = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
    check("sitemap includes tl5", seo.includes("/tl5"));
    check("sitemap has no admin", !seo.includes("/admin"));
    const ogImage = await fetch(`${BASE}/og/site.png`);
    check(
        "OG site image",
        ogImage.status === 200 && ogImage.headers.get("content-type") === "image/png"
    );

    const webAdmin = await login("web");
    check(
        "web login",
        webAdmin.response.status === 303 &&
            webAdmin.response.headers.get("location") === "/web/dashboard",
        webAdmin.response.headers.get("location") ?? ""
    );
    for (const path of [
        "/web/dashboard",
        "/web/plan",
        "/web/hub",
        "/web/profile",
        "/web/tickets",
        "/web/giftcards",
        "/web/wheel",
        "/web/affiliate",
        "/web/admin/dashboard",
        "/web/admin/users",
        "/web/admin/plans",
        "/web/admin/settings",
    ]) {
        const result = await page(path, webAdmin.cookie);
        check(`${path} renders`, result.response.status === 200, String(result.response.status));
    }
    const checkout = await fetch(`${BASE}/web/api/payments/stripe`, {
        method: "POST",
        headers: {
            Origin: BASE,
            cookie: webAdmin.cookie,
            "Content-Type": "application/x-www-form-urlencoded",
            "x-csrf-token": token((await page("/web/plan", webAdmin.cookie)).html),
            Accept: "application/json",
        },
        body: "plan=1",
    });
    check("checkout fails closed", checkout.status === 503, String(checkout.status));
    const maintenancePage = await page("/web/maintenance");
    check("maintenance page", maintenancePage.response.status === 200);
    const humans = await fetch(`${BASE}/humans.txt`);
    check(
        "humans.txt",
        humans.status === 200 && (await humans.text()).includes("richie-rich90454")
    );
    const crafted = await fetch(`${BASE}/`);
    check("crafted header", crafted.headers.get("x-crafted-by") === "richie-rich90454");

    console.log(
        failures === 0 ? "\nAll flow checks passed." : `\n${failures} flow check(s) failed.`
    );
    if (failures > 0) process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        if (child) {
            child.kill("SIGTERM");
            child.once("exit", () => {
                setTimeout(() => {
                    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
                    process.exit(process.exitCode ?? 0);
                }, 500);
            });
        } else {
            rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            process.exit(process.exitCode ?? 0);
        }
    });
