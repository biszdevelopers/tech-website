#!/usr/bin/env node
/**
 * Post-integration SEO smoke test. Uses only the Node standard library.
 *
 *   BASE=http://localhost:3000 node scripts/check-seo.mjs
 *
 * Exits nonzero on any failed assertion. Missing feed/OG routes are reported
 * as failures rather than crashes so the script stays usable while the main
 * server integration is still in progress.
 */

try {
    process.loadEnvFile();
} catch {
    /* real env wins */
}
const BASE = (process.env.BASE || `http://localhost:${process.env.PORT || 3000}`).replace(
    /\/+$/,
    ""
);
const REQUEST_TIMEOUT_MS = 15_000;

const PUBLIC_PAGES = [
    "/",
    "/tl1",
    "/tl5",
    "/tl6",
    "/tl1/relationships",
    "/search",
    "/submission",
    "/docs",
    "/web",
    "/web/plan",
];

const PRIVATE_PAGES = [
    { path: "/login", allow: [200] },
    { path: "/admin", allow: [404] },
    { path: "/web/login", allow: [200] },
    { path: "/web/register", allow: [200] },
    { path: "/web/dashboard", allow: [303, 401, 403] },
    { path: "/search?query=x", allow: [200] },
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let passed = 0;
const failures = [];

function section(title) {
    console.log(`\n${title}`);
}

function passCheck(label, checks = 1) {
    passed += checks;
    console.log(`PASS  ${label}${checks > 1 ? ` (${checks} checks)` : ""}`);
}

function failCheck(label, issues) {
    failures.push({ label, issues });
    console.log(`FAIL  ${label}`);
    for (const issue of issues) console.log(`      - ${issue}`);
}

function skipCheck(label, reason) {
    console.log(`SKIP  ${label} (${reason})`);
}

function assert(condition, issues, message) {
    if (!condition) issues.push(message);
}

async function get(path, options = {}) {
    const { binary = false, redirect = "manual" } = options;
    try {
        const response = await fetch(new URL(path, `${BASE}/`), {
            redirect,
            headers: {
                accept: binary
                    ? "image/png,image/*;q=0.8,*/*;q=0.5"
                    : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "user-agent": "tech-website-seo-check/1.0",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = binary ? await response.arrayBuffer() : await response.text();
        return {
            status: response.status,
            headers: response.headers,
            body,
        };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function decodeEntities(value) {
    return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
        if (code[0] === "#") {
            const hex = code[1] === "x" || code[1] === "X";
            const number = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
            return Number.isFinite(number) && number >= 0 && number <= 0x10ffff
                ? String.fromCodePoint(number)
                : match;
        }
        const named = {
            amp: "&",
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
            nbsp: " ",
        };
        return named[code.toLowerCase()] ?? match;
    });
}

function parseAttrs(tag) {
    const attrs = {};
    const body = tag.replace(/^<\s*[^\s>]+/, "").replace(/\/?>$/, "");
    const re = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = re.exec(body))) {
        attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
    return attrs;
}

function extractTags(html, name) {
    const found = [];
    const re = new RegExp(`<${name}\\b`, "gi");
    let match;
    while ((match = re.exec(html))) {
        let index = re.lastIndex;
        let quote = "";
        for (; index < html.length; index += 1) {
            const char = html[index];
            if (quote) {
                if (char === quote) quote = "";
            } else if (char === '"' || char === "'") {
                quote = char;
            } else if (char === ">") {
                break;
            }
        }
        const raw = html.slice(match.index, index + 1);
        found.push({ raw, attrs: parseAttrs(raw) });
        re.lastIndex = index + 1;
    }
    return found;
}

function findMeta(html, key, value) {
    const wanted = value.toLowerCase();
    for (const tag of extractTags(html, "meta")) {
        if ((tag.attrs[key] || "").toLowerCase() === wanted) return tag.attrs;
    }
    return null;
}

function findMetaContent(html, key) {
    return findMeta(html, "property", key)?.content ?? findMeta(html, "name", key)?.content ?? "";
}

function findLinkByRel(html, rel) {
    for (const tag of extractTags(html, "link")) {
        const tokens = (tag.attrs.rel || "").toLowerCase().split(/\s+/);
        if (tokens.includes(rel)) return tag.attrs;
    }
    return null;
}

function extractTitle(html) {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

function extractJsonLd(html) {
    const blocks = [];
    const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let match;
    while ((match = re.exec(html))) {
        const openTag = match[0].slice(0, match[0].indexOf(">") + 1);
        const attrs = parseAttrs(openTag);
        if ((attrs.type || "").toLowerCase() !== "application/ld+json") continue;
        blocks.push({ attrs, content: match[1] });
    }
    return blocks;
}

function isAbsoluteUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function normalizePath(path) {
    return path.replace(/\/+$/, "") || "/";
}

function hasNoindex(html, headers) {
    const robots = findMeta(html, "name", "robots")?.content || "";
    const header = headers.get("x-robots-tag") || "";
    return /noindex/i.test(robots) || /noindex/i.test(header);
}

function isPng(bytes) {
    return PNG_MAGIC.every((byte, index) => bytes[index] === byte);
}

async function checkPublicPage(path, titleOwners) {
    const label = `GET ${path}`;
    const page = await get(path);
    if (page.error) {
        failCheck(label, [`request failed: ${page.error}`]);
        return;
    }

    const issues = [];
    const html = page.body;
    assert(page.status === 200, issues, `status ${page.status}, expected 200`);

    const title = extractTitle(html);
    assert(title.length > 0, issues, "missing or empty <title>");
    if (title) {
        const key = title.toLowerCase();
        const owner = titleOwners.get(key) || { title, paths: [] };
        owner.paths.push(path);
        titleOwners.set(key, owner);
    }

    const description = findMeta(html, "name", "description")?.content?.trim() || "";
    assert(description.length > 0, issues, 'missing <meta name="description">');

    const canonical = findLinkByRel(html, "canonical")?.href || "";
    if (!canonical) {
        issues.push('missing <link rel="canonical">');
    } else if (!isAbsoluteUrl(canonical)) {
        issues.push(`canonical is not absolute: ${canonical}`);
    } else {
        const canonicalPath = normalizePath(new URL(canonical).pathname);
        const requestedPath = normalizePath(new URL(path, BASE).pathname);
        if (canonicalPath !== requestedPath) {
            issues.push(
                `canonical path ${canonicalPath} does not match requested ${requestedPath}`
            );
        }
    }

    const ogTitle = findMetaContent(html, "og:title").trim();
    const ogDescription = findMetaContent(html, "og:description").trim();
    const ogImage = findMetaContent(html, "og:image").trim();
    assert(ogTitle.length > 0, issues, 'missing <meta property="og:title">');
    assert(ogDescription.length > 0, issues, 'missing <meta property="og:description">');
    if (!ogImage) {
        issues.push('missing <meta property="og:image">');
    } else if (!isAbsoluteUrl(ogImage)) {
        issues.push(`og:image is not absolute: ${ogImage}`);
    }

    const twitterCard = findMetaContent(html, "twitter:card").trim();
    assert(twitterCard.length > 0, issues, 'missing <meta name="twitter:card">');

    const robots = findMeta(html, "name", "robots")?.content || "";
    assert(!/noindex/i.test(robots), issues, "public page is marked noindex");

    const h1Count = (html.match(/<h1\b/gi) || []).length;
    assert(h1Count === 1, issues, `found ${h1Count} <h1> elements, expected exactly 1`);

    const jsonLd = extractJsonLd(html);
    if (jsonLd.length === 0) {
        issues.push('missing <script type="application/ld+json">');
    }
    jsonLd.forEach((block, index) => {
        try {
            JSON.parse(block.content.replace(/^\uFEFF/, ""));
        } catch (error) {
            issues.push(
                `JSON-LD block ${index + 1} does not parse: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
        if (!block.attrs.nonce) {
            issues.push(`JSON-LD block ${index + 1} is missing a nonce attribute`);
        } else if (block.attrs.nonce === "__CSP_NONCE__") {
            issues.push(`JSON-LD block ${index + 1} still contains the nonce placeholder`);
        }
    });

    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 11);
}

async function checkPrivatePage(spec) {
    const label = `GET ${spec.path} (private)`;
    const page = await get(spec.path);
    if (page.error) {
        failCheck(label, [`request failed: ${page.error}`]);
        return;
    }

    const issues = [];
    assert(
        spec.allow.includes(page.status),
        issues,
        `status ${page.status}, expected ${spec.allow.join(" or ")}`
    );

    let html = page.body;
    if (REDIRECT_STATUSES.has(page.status)) {
        const location = page.headers.get("location");
        if (!location) {
            issues.push("redirect has no Location header");
        } else {
            const target = await get(location, { redirect: "follow" });
            if (target.error) issues.push(`redirect target failed: ${target.error}`);
            else html = target.body;
        }
    }

    assert(hasNoindex(html, page.headers), issues, "missing noindex robots directive");
    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 2);
}

async function checkSitemap() {
    const label = "GET /sitemap.xml";
    const page = await get("/sitemap.xml");
    if (page.error) {
        failCheck(label, [`request failed: ${page.error}`]);
        return;
    }

    const issues = [];
    assert(page.status === 200, issues, `status ${page.status}, expected 200`);
    assert(
        /xml/i.test(page.headers.get("content-type") || ""),
        issues,
        `content-type is ${page.headers.get("content-type") || "missing"}, expected XML`
    );

    const locs = [...page.body.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((match) =>
        decodeEntities(match[1].trim())
    );
    assert(locs.length > 0, issues, "sitemap contains no <loc> entries");

    const paths = new Set();
    for (const loc of locs) {
        if (!isAbsoluteUrl(loc)) {
            issues.push(`sitemap loc is not absolute: ${loc}`);
            continue;
        }
        const path = normalizePath(new URL(loc).pathname);
        paths.add(path);
        if (
            path === "/admin" ||
            path.startsWith("/admin/") ||
            path === "/login" ||
            path.startsWith("/login/") ||
            path === "/web/login" ||
            path.startsWith("/web/admin")
        ) {
            issues.push(`sitemap must not list ${path}`);
        }
    }

    for (const required of ["/tl5", "/tl6", "/tl1/relationships"]) {
        assert(paths.has(required), issues, `sitemap is missing ${required}`);
    }

    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 5);
}

async function checkRobots() {
    const label = "GET /robots.txt";
    const page = await get("/robots.txt");
    if (page.error) {
        failCheck(label, [`request failed: ${page.error}`]);
        return;
    }

    const issues = [];
    assert(page.status === 200, issues, `status ${page.status}, expected 200`);
    assert(
        /text\/plain/i.test(page.headers.get("content-type") || ""),
        issues,
        `content-type is ${page.headers.get("content-type") || "missing"}, expected text/plain`
    );
    assert(/user-agent\s*:/i.test(page.body), issues, "missing User-agent directive");
    const sitemap = /^sitemap\s*:\s*(\S+)/im.exec(page.body)?.[1] || "";
    if (!sitemap) {
        issues.push("missing Sitemap directive");
    } else if (
        !isAbsoluteUrl(sitemap) ||
        normalizePath(new URL(sitemap).pathname) !== "/sitemap.xml"
    ) {
        issues.push(`Sitemap directive must be an absolute /sitemap.xml URL, got ${sitemap}`);
    }

    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 4);
}

async function checkFeed() {
    const label = "GET /feed.xml";
    const page = await get("/feed.xml");
    if (page.error) {
        failCheck(label, [`request failed: ${page.error}`]);
        return;
    }

    const issues = [];
    assert(page.status === 200, issues, `status ${page.status}, expected 200`);
    assert(
        /(xml|rss)/i.test(page.headers.get("content-type") || ""),
        issues,
        `content-type is ${page.headers.get("content-type") || "missing"}, expected RSS/XML`
    );
    assert(/<rss\b/i.test(page.body), issues, "response body has no <rss> element");

    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 3);
}

async function checkPng(path) {
    const label = `GET ${path}`;
    const page = await get(path, { binary: true });
    if (page.error) {
        failCheck(label, [`request failed: ${page.error}`]);
        return;
    }

    const issues = [];
    assert(page.status === 200, issues, `status ${page.status}, expected 200`);
    assert(
        /image\/png/i.test(page.headers.get("content-type") || ""),
        issues,
        `content-type is ${page.headers.get("content-type") || "missing"}, expected image/png`
    );
    const bytes = new Uint8Array(page.body);
    assert(isPng(bytes), issues, "body does not start with the PNG magic bytes");

    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 3);
}

async function checkToolRedirect() {
    const label = "GET /tool/:id redirects to /tool/:id/:slug";
    let id = "";
    let expectedSlug = "";

    const sitemap = await get("/sitemap.xml");
    if (!sitemap.error && sitemap.status === 200) {
        const match = /<loc>[^<]*\/tool\/(\d+)(?:\/([^<]+?))?<\/loc>/i.exec(sitemap.body);
        if (match) {
            id = match[1];
            expectedSlug = decodeEntities(match[2] || "").trim();
        }
    }

    if (!id) {
        const tl = await get("/tl1");
        if (!tl.error && tl.status === 200) {
            const match = /\/tool\/(\d+)/.exec(tl.body);
            if (match) id = match[1];
        }
    }

    if (!id) {
        skipCheck(label, "no tool URL found in sitemap or /tl1");
        return;
    }

    const page = await get(`/tool/${id}`);
    if (page.error) {
        failCheck(label, [`request failed: ${page.error}`]);
        return;
    }

    const issues = [];
    if (!REDIRECT_STATUSES.has(page.status)) {
        issues.push(`status ${page.status}, expected a redirect to the slug URL`);
    } else {
        const location = page.headers.get("location") || "";
        if (!location) {
            issues.push("redirect has no Location header");
        } else {
            const target = new URL(location, `${BASE}/`);
            const prefix = `/tool/${id}/`;
            if (!target.pathname.startsWith(prefix) || target.pathname === prefix) {
                issues.push(`Location ${target.pathname} is not /tool/${id}/<slug>`);
            } else if (expectedSlug && target.pathname !== `${prefix}${expectedSlug}`) {
                issues.push(
                    `Location ${target.pathname} does not match sitemap slug /tool/${id}/${expectedSlug}`
                );
            }
        }
    }

    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 2);
}

function checkDuplicateTitles(titleOwners) {
    const label = "Public page titles are unique";
    const issues = [];
    for (const { title, paths } of titleOwners.values()) {
        if (paths.length > 1) {
            issues.push(`"${title}" is shared by ${paths.join(", ")}`);
        }
    }
    if (issues.length > 0) failCheck(label, issues);
    else passCheck(label, 1);
}

async function main() {
    console.log(`SEO check against ${BASE}`);

    section("Public pages");
    const titleOwners = new Map();
    for (const path of PUBLIC_PAGES) {
        await checkPublicPage(path, titleOwners);
    }
    checkDuplicateTitles(titleOwners);

    section("Private pages");
    for (const spec of PRIVATE_PAGES) {
        await checkPrivatePage(spec);
    }

    section("Crawler files");
    await checkSitemap();
    await checkRobots();
    await checkFeed();

    section("Open Graph images");
    await checkPng("/og/site.png");
    await checkPng("/og/domain/tl1.png");

    section("Canonical URLs");
    await checkToolRedirect();

    console.log("");
    if (failures.length === 0) {
        console.log(`SEO check passed: ${passed} checks.`);
    } else {
        console.log(
            `SEO check failed: ${failures.length} failing area(s), ${passed} checks passed.`
        );
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(`SEO check crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
