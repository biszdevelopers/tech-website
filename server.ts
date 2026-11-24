/**
 * Application entry point. Configuration, framework and routes meet here.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { env } from "./src/config/env";
import type { Context } from "./src/core/03-context";
import { loadViews, render, setViewHelpers } from "./src/core/views";
import { Application, pageCache } from "./src/core/01-application";
import { guards, mainSessions, optionalWebUser } from "./src/routes/guards";
import { getStrand, getTlConfig, tlList } from "./src/lib/tl-config";
import { registerMainSiteRoutes } from "./src/routes/main-site";
import { registerAdminRoutes } from "./src/routes/admin";
import { registerAdminAccountRoutes } from "./src/routes/admin-account";
import { registerWebRoutes } from "./src/routes/web";
import { registerWebAdminRoutes } from "./src/routes/web-admin";
import { registerPaymentRoutes } from "./src/routes/payments";
import {
    getAcceptedToolViews,
    getToolViewById,
    getToolsByMask,
    getStrandMask,
} from "./src/server/queries/submissions";
import { serveUpload } from "./src/lib/uploads";
import { getWebSettings } from "./src/lib/web-settings";
import { mainDb } from "./src/lib/db/main";
import { webDb } from "./src/lib/db/web";
import { toolPath, toolSlug } from "./src/lib/tool-path";
import {
    absoluteUrl,
    breadcrumbsLd,
    buildPageMeta,
    collectionLd,
    docsLd,
    ogDomainPath,
    ogSitePath,
    ogToolPath,
    organizationLd,
    toolLd,
    websiteLd,
    type PageMeta,
} from "./src/lib/seo";
import { generateDomainOg, generateSiteOg, generateToolOg } from "./src/lib/og";

// ---------------------------------------------------------------------------
// Shared page helpers
// ---------------------------------------------------------------------------

const DOM_TAGS = tlList.flatMap((config) =>
    config.strands.map((strand) => ({
        col: strand.domainColumn,
        label: strand.label,
        tl: config.id,
        slug: strand.slug,
        css: strand.cssClass,
    }))
);

const TIGHT_DESC = new Set(["tl2:14", "tl2:21", "tl3:20", "tl3:21"]);

function metaFor(input: Parameters<typeof buildPageMeta>[0]): PageMeta {
    return buildPageMeta(input);
}

function cardData() {
    return tlList.map((config) => ({
        id: config.id,
        href: `/${config.id}`,
        title: config.title,
        shortLabel: config.shortLabel,
        strands: config.strands.map((strand) => strand.label),
        items: config.strands.length ? config.strands.map((strand) => strand.label) : config.topics,
    }));
}

async function searchRender(query: string): Promise<string> {
    const q = query.trim();
    const tools = q ? await getAcceptedToolViews() : [];
    const needle = q.toLowerCase();
    const results = q
        ? tools.filter((tool) => {
              if (tool.searchText.includes(needle)) return true;
              return DOM_TAGS.some(
                  (tag) => tool.tags[tag.col] && tag.label.toLowerCase().includes(needle)
              );
          })
        : [];

    return render("search", {
        heading: q ? `Results for: ${q}` : "Search Tech Tools",
        q,
        resultCount: results.length,
        results: results.map((item) => ({
            ...item,
            activeTags: DOM_TAGS.filter((tag) => item.tags[tag.col]),
        })),
        meta: metaFor({
            title: q ? `Results for ${q}` : "Search Tech Tools",
            description:
                "Search accepted teaching technology tools by name, description, strand or submitter.",
            path: "/search",
            robots: q ? "private" : "public",
            jsonLd: [websiteLd()],
        }),
    });
}

async function tlRender(
    tl: string,
    query: Record<string, string>,
    activeSlug?: string
): Promise<{ html: string; meta: PageMeta } | null> {
    const config = getTlConfig(tl);
    if (!config) return null;
    const activeStrand = activeSlug ? getStrand(tl, activeSlug) : null;
    if (activeSlug && !activeStrand) return null;
    const checked = config.strands.map((strand) => {
        if (activeStrand) return strand.slug === activeStrand.slug;
        return query[strand.checkboxName] !== "0";
    });
    const selectedColumns = config.strands
        .filter((_, index) => checked[index])
        .map((strand) => strand.domainColumn);
    const mask = getStrandMask(selectedColumns);
    const tools =
        config.strands.length === 0 ? await getAcceptedToolViews() : await getToolsByMask(mask);
    const descriptionField = `${tl}_desc` as
        "tl1_desc" | "tl2_desc" | "tl3_desc" | "tl4_desc" | "tl5_desc" | "tl6_desc";
    const filtered = tools
        .filter((tool) => (config.strands.length === 0 ? Boolean(tool[descriptionField]) : true))
        .map((tool) => ({
            id: tool.id,
            techname: tool.techname,
            link: tool.link,
            displaytext: tool.displaytext,
            desc: tool[descriptionField] ?? "",
            updatedAt: tool.updatedAt,
            path: tool.path,
            resources: tool.resources,
            tight: TIGHT_DESC.has(`${tl}:${tool.id}`),
            tags: Object.fromEntries(
                config.strands.map((s) => [s.domainColumn, tool.tags[s.domainColumn]])
            ),
        }));
    const strandLinks = config.strands.map((strand) => ({
        label: strand.label,
        href: `/${tl}/${strand.slug}`,
    }));
    const pageTitle = activeStrand ? `${activeStrand.label} | ${config.title}` : config.title;
    const path = activeStrand ? `/${tl}/${activeStrand.slug}` : `/${tl}`;
    const meta = metaFor({
        title: pageTitle,
        description: config.description,
        path,
        ogType: "website",
        image: ogDomainPath(tl),
        jsonLd: [
            breadcrumbsLd([
                { name: "Home", url: "/" },
                { name: config.title, url: `/${tl}` },
                ...(activeStrand ? [{ name: activeStrand.label, url: path }] : []),
            ]),
            collectionLd(
                pageTitle,
                config.description,
                path,
                strandLinks.map((link) => ({ name: link.label, url: link.href })),
                filtered.map((tool) => ({ id: tool.id, techname: tool.techname }))
            ),
        ],
    });
    return {
        html: render("tl", {
            tl,
            config,
            checked,
            filtered,
            activeStrand,
            strandLinks,
            meta,
        }),
        meta,
    };
}

// ---------------------------------------------------------------------------
// System views
// ---------------------------------------------------------------------------

let toolIndex: Array<{ id: number; techname: string }> = [];

function refreshToolIndex(): void {
    void getAcceptedToolViews()
        .then((tools) => {
            toolIndex = tools.map((tool) => ({ id: tool.id, techname: tool.techname }));
        })
        .catch((error: unknown) => {
            console.error(
                JSON.stringify({
                    level: "error",
                    msg: "tool index refresh failed",
                    reason: error instanceof Error ? error.message : String(error),
                })
            );
        });
}

const notFoundPage = (url: string): string => {
    const words = url
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((w) => w.length >= 4);
    const suggestions = words
        .map((w) => toolIndex.find((t) => t.techname.toLowerCase().includes(w)))
        .filter((t): t is { id: number; techname: string } => Boolean(t))
        .slice(0, 5)
        .map((tool) => ({ ...tool, path: toolPath(tool) }));
    return render("not-found", {
        suggestions,
        meta: metaFor({
            title: "Page not found",
            description: "The requested page could not be found.",
            path: url,
            robots: "private",
        }),
    });
};

const errorPage = (ref: string, status: number, path: string): string =>
    render("error-page", {
        ref,
        status,
        meta: metaFor({
            title: status >= 500 ? "Something went wrong" : "Request could not be completed",
            description: "The request could not be completed.",
            path,
            robots: "private",
        }),
    });

// ---------------------------------------------------------------------------
// Application assembly
// ---------------------------------------------------------------------------

const app = new Application({
    notFoundPage,
    errorPage,
    isProd: env.isProd,
    guards,
});

app.get("/api/health", async (ctx) => {
    await Promise.all([mainDb.submission.count(), webDb.users.count()]);
    ctx.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/robots.txt", async (ctx) => {
    ctx.res.setHeader("Cache-Control", "public, max-age=3600");
    ctx.text(`User-agent: *\nAllow: /\nSitemap: ${env.siteOrigin}/sitemap.xml\n`);
});

app.get("/humans.txt", async (ctx) => {
    ctx.res.setHeader("Cache-Control", "public, max-age=86400");
    ctx.text(
        [
            "/* TEAM */",
            "Creator: richie-rich90454",
            "Site: BIBS-C Tech Tools",
            "Location: BASIS International and Bilingual Schools China",
            "",
            "/* SITE */",
            `Standards: ${env.siteOrigin}`,
            "Stack: Node, EJS, SQLite",
            "Languages: English",
            "",
            "A quiet shelf for the curious: the first tool is always the one that starts with I.",
        ].join("\n")
    );
});

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

app.get("/sitemap.xml", async (ctx) => {
    const tools = await getAcceptedToolViews();
    const urls: string[] = [];
    const add = (path: string, lastmod?: number) => {
        urls.push(
            `  <url><loc>${xmlEscape(absoluteUrl(path))}</loc>${
                lastmod ? `<lastmod>${new Date(lastmod * 1000).toISOString()}</lastmod>` : ""
            }</url>`
        );
    };
    add("/");
    for (const config of tlList) {
        add(`/${config.id}`);
        for (const strand of config.strands) add(`/${config.id}/${strand.slug}`);
    }
    add("/docs");
    add("/web");
    add("/web/plan");
    for (const tool of tools) add(tool.path, tool.updatedAt);
    ctx.res.setHeader("Cache-Control", "public, max-age=3600");
    ctx.xml(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
    );
});

app.get("/feed.xml", async (ctx) => {
    const tools = (await getAcceptedToolViews()).slice(0, 50);
    const items = tools.map((tool) => {
        const description = String(tool.tl1_desc || tool.tl2_desc || tool.displaytext || "").slice(
            0,
            400
        );
        return [
            "    <item>",
            `      <title>${xmlEscape(tool.techname)}</title>`,
            `      <link>${xmlEscape(absoluteUrl(tool.path))}</link>`,
            `      <guid>${xmlEscape(absoluteUrl(tool.path))}</guid>`,
            `      <pubDate>${new Date((tool.updatedAt || Date.now() / 1000) * 1000).toUTCString()}</pubDate>`,
            `      <description>${xmlEscape(description)}</description>`,
            "    </item>",
        ].join("\n");
    });
    ctx.res.setHeader("Cache-Control", "public, max-age=3600");
    ctx.xml(
        `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>BIBS-C Tech Tools</title><link>${xmlEscape(
            absoluteUrl("/")
        )}</link><description>Recently documented teaching technology tools.</description>${items.join("")}</channel></rss>\n`
    );
});

// Open Graph images. Filenames include updatedAt so edits invalidate naturally.
async function sendPng(ctx: Context, path: string): Promise<void> {
    if (!existsSync(path)) {
        ctx.throw(404, "Image not found.");
        return;
    }
    const stat = statSync(path);
    ctx.res.setHeader("Content-Type", "image/png");
    ctx.res.setHeader("Cache-Control", "public, max-age=86400");
    ctx.res.setHeader("Content-Length", stat.size);
    if (ctx.raw.headers["if-none-match"] === `"${stat.size}-${stat.mtimeMs}"`) {
        ctx.res.statusCode = 304;
        ctx.res.end();
        return;
    }
    ctx.res.setHeader("ETag", `"${stat.size}-${stat.mtimeMs}"`);
    if (ctx.method === "HEAD") {
        ctx.res.end();
        return;
    }
    const stream = createReadStream(path);
    stream.on("error", () => {
        if (!ctx.res.headersSent) {
            ctx.res.statusCode = 404;
            ctx.res.end("Not found");
        } else {
            ctx.res.destroy();
        }
    });
    stream.pipe(ctx.res);
}

app.get("/og/site.png", async (ctx) => {
    try {
        await sendPng(ctx, await generateSiteOg());
    } catch {
        ctx.throw(503, "Preview image unavailable.");
    }
});

app.get("/og/domain/:tl.png", async (ctx) => {
    const tl = String(ctx.params["tl.png"] ?? "").replace(/\.png$/, "");
    const config = getTlConfig(tl);
    if (!config) {
        ctx.throw(404, "Image not found.");
        return;
    }
    try {
        await sendPng(
            ctx,
            await generateDomainOg({
                tl,
                title: config.title,
                description: config.description,
            })
        );
    } catch {
        ctx.throw(503, "Preview image unavailable.");
    }
});

app.get("/og/tool/:id/:slug", async (ctx) => {
    const id = Number(ctx.params.id);
    const requested = String(ctx.params.slug ?? "").replace(/\.png$/, "");
    const tool = await getToolViewById(id);
    if (!tool || requested !== toolSlug(tool.techname, tool.id)) {
        ctx.throw(404, "Image not found.");
        return;
    }
    const config =
        tlList.find((c) => Boolean(tool[`${c.id}_desc` as keyof typeof tool])) ?? tlList[0];
    try {
        await sendPng(
            ctx,
            await generateToolOg({
                id: tool.id,
                slug: toolSlug(tool.techname, tool.id),
                name: tool.techname,
                description:
                    tool.tl1_desc ||
                    tool.tl2_desc ||
                    tool.displaytext ||
                    "Teaching technology tool",
                domainLabel: config.title,
                updatedAt: tool.updatedAt,
            })
        );
    } catch {
        ctx.throw(503, "Preview image unavailable.");
    }
});

// Home page: cached as finished HTML in production.
const HTML_CACHE = env.isProd;

const TL_CARDS = cardData();
app.get("/", async (ctx) => {
    const meta = metaFor({
        title: "BIBS-C Tech Tools | Teaching and Learning Technology Directory",
        description:
            "A curated directory of teaching technology tools organized across six Teaching and Learning domains.",
        path: "/",
        image: ogSitePath(),
        jsonLd: [websiteLd(), organizationLd()],
    });
    const cached = HTML_CACHE
        ? await pageCache.remember("home", async () => render("home", { cards: TL_CARDS, meta }))
        : render("home", { cards: TL_CARDS, meta });
    ctx.htmlRaw(cached);
});

app.get("/favicon.ico", async (ctx) => {
    ctx.redirect("/images/favicon.png", 301);
});

app.get("/uploads/:file", async (ctx) => {
    const file = ctx.params.file;
    const id = Number(file.replace(/\.[a-z]+$/i, ""));
    if (!Number.isFinite(id)) ctx.throw(404, "Not found");
    const tool = await getToolViewById(id);
    const session = mainSessions.load(ctx);
    const loginRow = session?.islogin ? await mainDb.login.findFirst() : null;
    const adminCheck = Boolean(
        session?.islogin && loginRow && Number(session.sv ?? 0) === Number(loginRow.sessionVersion)
    );
    if (!tool && !adminCheck) {
        ctx.throw(404, "Not found");
        return;
    }
    if (!serveUpload(ctx, file)) ctx.throw(404, "Not found");
});

// Maintenance gate for the IPstress subproject.
app.use(async (ctx, next) => {
    if (!ctx.path.startsWith("/web")) {
        await next();
        return;
    }
    const exempt =
        ctx.path.startsWith("/web/maintenance") ||
        ctx.path.startsWith("/web/admin") ||
        ctx.path.startsWith("/web/login") ||
        ctx.path === "/web/api/auth/login" ||
        ctx.path === "/web/api/auth/logout" ||
        ctx.path.startsWith("/web/images/") ||
        ctx.path.startsWith("/web/api/payments/stripe/webhook") ||
        ctx.path.startsWith("/web/api/admin/");
    if (exempt) {
        await next();
        return;
    }
    const settings = await getWebSettings();
    if (settings.maintaince === "1") {
        if (ctx.path.startsWith("/web/api/")) ctx.json({ error: "Maintenance mode." }, 503);
        else ctx.redirect("/web/maintenance");
        return;
    }
    await next();
});

registerMainSiteRoutes(app);
registerAdminRoutes(app);
registerAdminAccountRoutes(app);
registerWebRoutes(app);
registerWebAdminRoutes(app);
registerPaymentRoutes(app);

// Web public pages.
app.get("/web/plan", async (ctx) => {
    const user = await optionalWebUser(ctx);
    const plans = await webDb.plans.findMany({ orderBy: { price: "asc" } });
    const visible =
        user && Number(user.rank) >= 1 ? plans : plans.filter((plan) => Number(plan.private) !== 1);
    const meta = metaFor({
        title: "Plans | IPstress",
        description: "Choose a stress testing plan with clear duration and concurrency limits.",
        path: "/web/plan",
        jsonLd: [websiteLd()],
    });
    ctx.htmlRaw(
        render("web-plan", {
            plans: visible,
            signedIn: Boolean(user),
            error: ctx.query.get("error") ?? "",
            meta,
        })
    );
});

app.get("/web/tickets/new", async (ctx) => {
    const user = await optionalWebUser(ctx);
    if (!user) {
        ctx.redirect("/web/login?next=%2Fweb%2Ftickets%2Fnew", 303);
        return;
    }
    ctx.htmlRaw(
        render("web-tickets-new", {
            signedIn: true,
            meta: metaFor({
                title: "New Ticket | IPstress",
                path: "/web/tickets/new",
                robots: "private",
            }),
        })
    );
});

app.get("/web/giftcards", async (ctx) => {
    const user = await optionalWebUser(ctx);
    ctx.htmlRaw(
        render("web-giftcards", {
            signedIn: Boolean(user),
            redeemed: ctx.query.get("redeemed") ?? "",
            error: ctx.query.get("error") ?? "",
            meta: metaFor({
                title: "Gift Cards | IPstress",
                path: "/web/giftcards",
                robots: "private",
            }),
        })
    );
});

app.get("/web/affiliate", async (ctx) => {
    const user = await optionalWebUser(ctx);
    const stats =
        user === null
            ? null
            : {
                  referralLink:
                      user.ID > 0 ? `${env.siteOrigin}/web/register?ref=${user.ID}` : "N/A",
                  referralCount: await webDb.users.count({ where: { referedBy: user.ID } }),
                  referralBalance: user.referralbalance,
              };
    ctx.htmlRaw(
        render("web-affiliate", {
            signedIn: Boolean(user),
            stats,
            meta: metaFor({
                title: "Affiliate | IPstress",
                path: "/web/affiliate",
                robots: "private",
            }),
        })
    );
});

app.get("/web/wheel", async (ctx) => {
    const user = await optionalWebUser(ctx);
    if (!user) {
        ctx.redirect("/web/login?next=%2Fweb%2Fwheel", 303);
        return;
    }
    ctx.htmlRaw(
        render("web-wheel", {
            signedIn: true,
            meta: metaFor({
                title: "Lucky Wheel | IPstress",
                path: "/web/wheel",
                robots: "private",
            }),
        })
    );
});

app.get("/web/maintenance", async (ctx) => {
    const settings = await getWebSettings();
    ctx.htmlRaw(
        render("web-maintenance", {
            description: settings.description || "Premium IP stress testing service",
            meta: metaFor({
                title: "Maintenance | IPstress",
                path: "/web/maintenance",
                robots: "private",
            }),
        })
    );
});

app.get("/web", async (ctx) => {
    const meta = metaFor({
        title: "IPstress | L4 and L7 Stress Testing",
        description: "IP stress testing with clear concurrency, duration and support terms.",
        path: "/web",
        image: ogSitePath(),
        jsonLd: [websiteLd()],
    });
    const body = HTML_CACHE
        ? (pageCache.get("web-home") ??
          (pageCache.set("web-home", render("web-landing", { meta })), pageCache.get("web-home")))
        : render("web-landing", { meta });
    ctx.htmlRaw(body!);
});

app.get("/web/login", async (ctx) => {
    ctx.htmlRaw(
        render("web-login", {
            error: ctx.query.get("error") ?? "",
            next: ctx.query.get("next") ?? "",
            meta: metaFor({ title: "Login | IPstress", path: "/web/login", robots: "private" }),
        })
    );
});

app.get("/web/register", async (ctx) => {
    ctx.htmlRaw(
        render("web-register", {
            ref: ctx.query.get("ref") ?? "",
            error: ctx.query.get("error") ?? "",
            meta: metaFor({
                title: "Register | IPstress",
                path: "/web/register",
                robots: "private",
            }),
        })
    );
});

app.get("/docs", async (ctx) => {
    const meta = metaFor({
        title: "Project Docs | BIBS-C Tech Tools",
        description: "How the BIBS-C Tech Tools directory is built, deployed and maintained.",
        path: "/docs",
        jsonLd: [docsLd()],
    });
    const cached = HTML_CACHE
        ? await pageCache.remember("docs", async () => render("docs", { meta }))
        : render("docs", { meta });
    ctx.htmlRaw(cached);
});

// Canonical tool URL, with old links permanently redirected.
app.get("/tool/:id/:slug", async (ctx) => {
    const id = Number(ctx.params.id);
    const tool = await getToolViewById(id);
    if (!tool) {
        ctx.throw(404, "Tool not found.");
        return;
    }
    const slug = toolSlug(tool.techname, tool.id);
    if (String(ctx.params.slug) !== slug) {
        ctx.redirect(toolPath(tool), 301);
        return;
    }
    const configs = tlList;
    const primaryConfig =
        configs.find((config) => Boolean(tool[`${config.id}_desc` as keyof typeof tool])) ??
        configs[0];
    const tlSections = configs.map((config) => ({
        id: config.id,
        title: config.title,
        shortLabel: config.shortLabel,
        description: tool[`${config.id}_desc` as keyof typeof tool] as string,
    }));
    const strands = DOM_TAGS.filter((tag) => tool.tags[tag.col]);
    const resources = tool.resources;
    const meta = metaFor({
        title: `${tool.techname} | BIBS-C Tech Tools`,
        description:
            tool.tl1_desc ||
            tool.tl2_desc ||
            tool.tl3_desc ||
            tool.displaytext ||
            "Teaching technology tool.",
        path: tool.path,
        ogType: "article",
        image: `${ogToolPath(tool)}?v=${tool.updatedAt}`,
        jsonLd: [
            breadcrumbsLd([
                { name: "Home", url: "/" },
                { name: "Search", url: "/search" },
                { name: tool.techname, url: tool.path },
            ]),
            toolLd(tool, primaryConfig, `${ogToolPath(tool)}?v=${tool.updatedAt}`),
        ],
    });
    const key = `tool:${tool.id}`;
    const cached = HTML_CACHE
        ? await pageCache.remember(key, async () =>
              render("tool", { tool, strands, tlSections, resources, meta })
          )
        : render("tool", { tool, strands, tlSections, resources, meta });
    ctx.htmlRaw(cached);
});

app.get("/tool/:id", async (ctx) => {
    const id = Number(ctx.params.id);
    const tool = await getToolViewById(id);
    if (!tool) {
        ctx.throw(404, "Tool not found.");
        return;
    }
    ctx.redirect(toolPath(tool), 301);
});

app.get("/search", async (ctx) => {
    const q = (ctx.query.get("query") ?? "").slice(0, 200);
    ctx.htmlRaw(await searchRender(q));
});

// Dedicated strand pages.
app.get("/:tl/:strand", async (ctx) => {
    const tl = ctx.params.tl;
    const strand = ctx.params.strand;
    const config = getTlConfig(tl);
    if (!config) {
        ctx.throw(404, "Page not found.");
        return;
    }
    const rendered = await tlRender(tl, {}, strand);
    if (!rendered) {
        ctx.throw(404, "Page not found.");
        return;
    }
    const key = `tl:${tl}:${strand}`;
    const cached = HTML_CACHE
        ? await pageCache.remember(key, async () => rendered.html)
        : rendered.html;
    ctx.htmlRaw(cached);
});

// TL listing pages.
app.get("/:tl", async (ctx) => {
    const query: Record<string, string> = {};
    ctx.query.forEach((value, key) => {
        query[key] = value;
    });
    const config = getTlConfig(ctx.params.tl);
    const bits = config
        ? config.strands.map((s) => (query[s.checkboxName] !== "0" ? "1" : "0")).join("")
        : "x";
    const cacheKey = `tl:${ctx.params.tl}:all:${bits}`;
    let body: string | undefined = HTML_CACHE ? pageCache.get(cacheKey) : undefined;
    if (body === undefined) {
        const rendered = await tlRender(ctx.params.tl, query);
        if (!rendered) {
            ctx.throw(404, "Page not found.");
            return;
        }
        body = rendered.html;
        if (HTML_CACHE) pageCache.set(cacheKey, body);
    }
    ctx.htmlRaw(body);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
loadViews();
setViewHelpers({ tlList, tlCards: TL_CARDS });

async function boot(): Promise<void> {
    await app.listen(env.port);
    console.log(
        JSON.stringify({ level: "info", msg: "listening", port: env.port, prod: env.isProd })
    );

    const stop = async (): Promise<void> => {
        console.log(JSON.stringify({ level: "info", msg: "shutting down" }));
        await app.shutdown();
        process.exit(0);
    };
    process.on("SIGTERM", () => void stop());
    process.on("SIGINT", () => void stop());
}

boot().catch((err: Error) => {
    console.error(JSON.stringify({ level: "error", msg: "boot failed", reason: err.message }));
    process.exit(1);
});
refreshToolIndex();
