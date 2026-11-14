/**
 * ============================================================================
 * CORE MODULE 07 - STATIC FILE SERVER
 * READING ORDER: after 03-context; no other core dependencies.
 * ============================================================================
 *
 * PURPOSE
 * Serves everything under dist/public (stylesheets, images, fonts, the compiled
 * ES5 JavaScript) with correct caching semantics. This is deliberately
 * boring, well-guarded code - static file servers are a classic source of
 * path-traversal CVEs ("GET /../../etc/passwd"), so every defensive line is
 * annotated below.
 *
 * PERFORMANCE NOTES (why this is fast without being clever)
 * - stat() results are memoized (bounded map): repeat requests skip disk.
 * - ETags are computed from size+mtime: identical files keep their ETag, so
 *   browsers get cheap 304 Not Modified responses instead of re-downloads.
 * - Build step pre-compresses text assets to .gz and .br siblings; this module
 *   picks one based on Accept-Encoding. Compression happens ONCE at build,
 *   never per request.
 * - Hashed build outputs (dist/public/js/*) get `immutable` caching: visitors never
 *   re-request them until the filename changes.
 *
 * EXTEND IT
 * New file type? Add its MIME type to CONTENT_TYPES. Streaming range requests
 * (video scrubbing)? That belongs in a TODO(roadmap), not in v1 - no media here.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Context } from "./03-context";

const CONTENT_TYPES: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
};

interface AssetInfo {
    size: number;
    mtimeMs: number;
    brSize: number;
    gzSize: number;
}

/** Built once at boot; request-time lookups are plain hash hits. */
const manifest = new Map<string, AssetInfo>();

function buildManifest(root: string): void {
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (entry.name.endsWith(".br") || entry.name.endsWith(".gz")) continue;
            const stat = statSync(full);
            const rel = "/" + full.slice(root.length + 1).split(sep).join("/");
            manifest.set(rel, {
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                brSize: existsSync(`${full}.br`) ? statSync(`${full}.br`).size : 0,
                gzSize: existsSync(`${full}.gz`) ? statSync(`${full}.gz`).size : 0,
            });
        }
    };
    walk(root);
}

export class StaticFiles {
    /** Absolute root every request path must resolve inside (traversal guard). */
    private readonly rootAbs: string;

    constructor(private readonly rootRelative = "dist/public") {
        // Single source of truth: the BUILT tree. There is no dev/prod
        // dual-root anymore - `npm run build` (or any dev watcher) fills
        // dist/public, and this server only ever serves from there. A missing
        // tree is a boot-time configuration error, not a silent fallback.
        const root = resolve(process.cwd(), rootRelative);
        if (!existsSync(root)) {
            throw new Error(`Static assets not found at ${root}. Run "npm run build" first.`);
        }
        this.rootAbs = root;
        buildManifest(root);
    }

    /**
     * Attempt to serve a static asset. Returns false when nothing matched so
     * the router can fall through to page routes (and eventually the 404 view).
     */
    serve(ctx: Context): boolean {
        if (ctx.method !== "GET" && ctx.method !== "HEAD") return false;
        let urlPath: string;
        try {
            urlPath = decodeURIComponent(ctx.path);
        } catch {
            return false; // malformed escape -> router 404s, never a 500
        }
        // ---- TRAVERSAL GUARD -------------------------------------------------
        const absolute = resolve(this.rootAbs, `.${urlPath}`);
        if (!absolute.startsWith(this.rootAbs + sep)) return false;
        // ----------------------------------------------------------------------

        let info = manifest.get(urlPath);
        if (!info && process.env.NODE_ENV !== "production") {
            // Dev watchers can add files after boot; fall back to one stat.
            try {
                if (existsSync(absolute) && statSync(absolute).isFile()) {
                    const stat = statSync(absolute);
                    info = { size: stat.size, mtimeMs: stat.mtimeMs, brSize: 0, gzSize: 0 };
                }
            } catch {
                info = undefined;
            }
        }
        if (!info) return false;

        const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
        ctx.res.setHeader("ETag", etag);
        const versioned = Boolean(ctx.url.searchParams.get("v"));
        if (urlPath.startsWith("/js/") || urlPath.startsWith("/css/")) {
            ctx.res.setHeader(
                "Cache-Control",
                versioned ? "public, max-age=31536000, immutable" : "no-cache"
            );
        } else if (urlPath.startsWith("/fonts/")) {
            ctx.res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
            ctx.res.setHeader("Cache-Control", "public, max-age=604800");
        }

        if (ctx.raw.headers["if-none-match"] === etag) {
            ctx.res.statusCode = 304;
            ctx.res.end();
            return true;
        }

        const contentType = CONTENT_TYPES[extname(absolute).toLowerCase()];
        if (!contentType) return false;
        ctx.res.setHeader("Content-Type", contentType);

        const accept = String(ctx.raw.headers["accept-encoding"] ?? "");
        if (accept.includes("br") && info.brSize > 0) {
            ctx.res.setHeader("Content-Encoding", "br");
            ctx.res.setHeader("Vary", "Accept-Encoding");
            ctx.res.setHeader("Content-Length", info.brSize);
            if (ctx.method === "HEAD") return (ctx.res.end(), true);
            createReadStream(`${absolute}.br`).pipe(ctx.res);
            return true;
        }
        if (accept.includes("gzip") && info.gzSize > 0) {
            ctx.res.setHeader("Content-Encoding", "gzip");
            ctx.res.setHeader("Vary", "Accept-Encoding");
            ctx.res.setHeader("Content-Length", info.gzSize);
            if (ctx.method === "HEAD") return (ctx.res.end(), true);
            createReadStream(`${absolute}.gz`).pipe(ctx.res);
            return true;
        }

        ctx.res.setHeader("Content-Length", info.size);
        if (ctx.method === "HEAD") {
            ctx.res.end();
            return true;
        }
        createReadStream(absolute).pipe(ctx.res);
        return true;
    }
}

// Exported for unit tests that assert traversal attempts are refused.
export function resolvesInsideRoot(rootAbs: string, urlPath: string): boolean {
    return resolve(rootAbs, `.${decodeURIComponent(urlPath)}`).startsWith(rootAbs + sep);
}
