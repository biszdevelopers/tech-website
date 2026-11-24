/**
 * ============================================================================
 * CORE MODULE 03 - REQUEST CONTEXT
 * READING ORDER: 04-html -> 06-cache -> 03-context -> 02-router
 * ============================================================================
 *
 * PURPOSE
 * A Context ("ctx") is one visitor's single request, wrapped in a friendly,
 * fully-typed object. Every route handler receives exactly one argument - the
 * ctx - and everything it might need hangs off of it:
 *
 *   app.get('/hello/:name', async (ctx) => {
 *       const name = ctx.params.name;          // URL parameter
 *       const page  = ctx.query.get('page');   // ?page=2
 *       const form  = await ctx.body(schema);  // parsed + validated POST data
 *       ctx.html(renderSomething());
 *   });
 *
 * DESIGN NOTE FOR REVIEWERS
 * Node gives us a raw IncomingMessage/ServerResponse pair. Raw pairs are
 * error-prone (easy to forget headers, easy to double-send bodies), so we wrap
 * them once here. This is the ONLY file that touches the raw objects; every
 * other module works on Context, which keeps code testable and portable.
 *
 * LEARN: THE ONE-RESPONSE RULE
 * A HTTP response must be ended exactly once. Every send method below guards
 * with `this.finished` so calling ctx.json() twice can never corrupt a reply -
 * the second call is ignored. Defensive, cheap, and eliminates a whole bug
 * class juniors hit constantly in raw-Node code.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import type { ZodType } from "zod";
import { renderToString, type Html } from "./04-html";
import { HttpError } from "./09-errors";
import { env } from "../config/env";
import { verifyCsrfToken } from "../lib/csrf";

/** Hard ceiling on any request body. Blocks memory-exhaustion DoS attempts. */
const MAX_BODY_BYTES = 8_000_000; // 8 MB for CSV imports and admin form posts

/**
 * Stamp the server-side theme on the real root <html> tag. Kept pure and
 * exported so the replacement cannot silently swallow the original attributes.
 */
export function stampTheme(html: string, theme: "dark" | "light"): string {
    return html.replace(/<html(\s[^>]*)?>/i, (match, attrs: string | undefined) =>
        /data-theme/i.test(match) ? match : `<html${attrs ?? ""} data-theme="${theme}">`
    );
}

export class Context {
    /** Route parameters filled in by the Router, e.g. /tickets/:id -> ctx.params.id */
    public readonly params: Record<string, string> = {};

    readonly url: URL;
    /** True when the raw request target could not be parsed as a URL. */
    readonly invalidTarget: boolean;
    /** Per-request CSRF token, filled by the security middleware. */
    csrfToken = "";
    /** Per-request CSP nonce used by the JSON-LD block. */
    cspNonce = "";
    private readonly cookieBag = new Map<string, string>();
    private finished = false;
    private parsedBody: unknown;

    constructor(
        public readonly raw: IncomingMessage,
        public readonly res: ServerResponse
    ) {
        // Canonical origin: the Host header is attacker-controlled, so it is
        // never used to build absolute URLs or CSRF checks.
        let url: URL;
        let invalidTarget = false;
        try {
            url = new URL(this.raw.url ?? "/", env.siteOrigin);
        } catch {
            // A target like "//" is scheme-relative and throws. Treat it as a
            // missing page instead of letting the constructor reject outside
            // the error boundary and crash the process.
            url = new URL("/", env.siteOrigin);
            invalidTarget = true;
        }
        this.url = url;
        this.invalidTarget = invalidTarget;
        const rawCookie = this.raw.headers.cookie;
        if (rawCookie) {
            for (const pair of rawCookie.split(";")) {
                const eq = pair.indexOf("=");
                if (eq === -1) continue;
                this.cookieBag.set(pair.slice(0, eq).trim(), safeDecode(pair.slice(eq + 1).trim()));
            }
        }
    }

    get method(): string {
        return this.raw.method ?? "GET";
    }

    /** Pathname without query string, e.g. "/web/tickets". */
    get path(): string {
        return this.url.pathname;
    }

    /** Query parameters as a standard URLSearchParams (?a=1&b=2). */
    get query(): URLSearchParams {
        return this.url.searchParams;
    }

    /**
     * Client IP. X-Forwarded-For is only read when TRUST_PROXY=true; otherwise
     * it is spoofable and would let anyone bypass rate limits.
     */
    get ip(): string {
        if (env.trustProxy) {
            // nginx appends the real peer to the end. The leftmost entries are
            // client-supplied and therefore spoofable; trust only the last hop.
            const forwarded = String(this.raw.headers["x-forwarded-for"] ?? "")
                .split(",")
                .pop()
                ?.trim();
            if (forwarded) return forwarded;
        }
        return this.raw.socket.remoteAddress || "unknown";
    }

    /** True when the request carries one of our session cookies. */
    hasAuthCookie(): boolean {
        return Boolean(
            this.cookie("main-session") ||
            this.cookie("web-session") ||
            this.cookie("__Host-main-session") ||
            this.cookie("__Host-web-session")
        );
    }

    /**
     * Signed-token check. A valid HMAC proves the token was issued by this
     * server, so it does not depend on the cookie surviving a tab race.
     */
    verifyCsrf(provided: string): boolean {
        return verifyCsrfToken(provided);
    }

    cookie(name: string): string | undefined {
        return this.cookieBag.get(name);
    }

    /** Queue a Set-Cookie header. Options mirror the security posture we run site-wide. */
    setCookie(
        name: string,
        value: string,
        opts: {
            httpOnly?: boolean;
            secure?: boolean;
            sameSite?: "Lax" | "Strict";
            maxAge?: number;
        } = {}
    ): void {
        let c = `${name}=${value}; Path=/`;
        if (opts.httpOnly) c += "; HttpOnly";
        if (opts.secure) c += "; Secure";
        c += `; SameSite=${opts.sameSite ?? "Lax"}`;
        if (opts.maxAge !== undefined) c += `; Max-Age=${Math.floor(opts.maxAge)}`;
        this.res.setHeader("Set-Cookie", [...normalize(this.res.getHeader("Set-Cookie")), c]);
    }

    /**
     * Read and validate the request body ONCE (results are memoized).
     * The raw parse is cached separately from validation so a schema is
     * ALWAYS applied, even when middleware has already read the body.
     */
    async body<T>(schema?: ZodType<T>): Promise<T> {
        let parsed = this.parsedBody;
        if (parsed === undefined) {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of this.raw) {
                size += (chunk as Buffer).length;
                if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
                chunks.push(chunk as Buffer);
            }
            const rawText = Buffer.concat(chunks).toString("utf8");
            const contentType = String(this.raw.headers["content-type"] ?? "");
            if (contentType.includes("application/json")) {
                try {
                    parsed = JSON.parse(rawText || "{}");
                } catch {
                    throw new HttpError(400, "Malformed JSON body.");
                }
            } else {
                parsed = Object.fromEntries(new URLSearchParams(rawText));
            }
            this.parsedBody = parsed;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            parsed = {};
            this.parsedBody = parsed;
        }
        if (!schema) return parsed as T;
        const result = schema.safeParse(parsed);
        if (!result.success) {
            throw new HttpError(400, result.error.issues[0]?.message ?? "Validation failed.");
        }
        return result.data;
    }

    /** Convenience for classic HTML <form> posts (urlencoded fields as strings). */
    async form(): Promise<Record<string, string>> {
        return (await this.body()) as Record<string, string>;
    }

    /** Send a rendered page. Content-Type + charset are fixed for the whole site. */
    html(page: Html, status = 200): void {
        this.send(renderToString(page), status, "text/html; charset=utf-8");
    }

    /**
     * Low-level HTML sender for infrastructure modules (the error boundary)
     * that assemble pages as plain strings. Application views should prefer
     * the typed html() above so unescaped strings cannot sneak into responses.
     */
    htmlRaw(body: string, status = 200): void {
        this.send(this.withServerTheme(body), status, "text/html; charset=utf-8");
    }

    /**
     * SERVER-RENDERED THEME: when the visitor's `theme` cookie says "dark",
     * stamp data-theme on the root <html> element before anything leaves the
     * server. The attribute therefore exists in the first byte of HTML - no
     * flash of wrong theme, no inline script (CSP-safe), works with JS
     * disabled. The toggle button keeps the cookie fresh client-side.
     */
    private withServerTheme(html: string): string {
        const theme = this.cookie("theme");
        if (theme !== "dark" && theme !== "light") return html;
        return stampTheme(html, theme);
    }

    /** Send a JSON payload (API routes). */
    json(data: unknown, status = 200): void {
        this.send(JSON.stringify(data), status, "application/json; charset=utf-8");
    }

    /** Plain-text reply (tiny utilities, health checks). */
    text(body: string, status = 200): void {
        this.send(body, status, "text/plain; charset=utf-8");
    }

    /** XML reply (sitemap). */
    xml(body: string, status = 200): void {
        this.send(body, status, "application/xml; charset=utf-8");
    }

    /**
     * Redirect. Default 307 preserves the verb exactly like the previous
     * framework did (POST-login -> dashboard stayed POST through the hop);
     * pass 303 See Other when a completed form should land on a clean GET.
     */
    redirect(location: string, status = 307): void {
        if (this.finished) return;
        this.finished = true;
        this.res.statusCode = status;
        this.res.setHeader("Location", location);
        this.res.end();
    }

    /** Throw inside handlers to short-circuit with an HTTP status. */
    throw(status: number, message?: string): never {
        throw new HttpError(status, message);
    }

    /**
     * Stage a one-shot success/info message shown after a redirect
     * (POST -> redirect -> GET reads and clears it - the classic PRG pattern).
     * Safety note: the value is escaped by html`` at render time and can only
     * ever be read back by the SAME browser that set it, so an unsigned cookie
     * is sufficient here; no server state required.
     */
    flash(message: string): void {
        this.setCookie("flash", encodeURIComponent(message), { httpOnly: true });
    }

    /** Read-and-clear the pending flash message, if any. */
    takeFlash(): string | undefined {
        const value = this.cookie("flash");
        if (value === undefined) return undefined;
        this.setCookie("flash", "", { maxAge: 0 });
        const decoded = safeDecode(value);
        return decoded.length > 0 ? decoded : undefined;
    }

    private send(text: string, status: number, contentType: string): void {
        if (this.finished) return; // one-response rule: see class docs
        let payload = text;
        if (contentType.startsWith("text/html")) {
            payload = payload.split("__CSP_NONCE__").join(this.cspNonce);
            payload = this.injectCsrf(payload);
            payload = this.injectAriaLabels(payload);
        }

        const etag = `"${createHash("sha1").update(payload).digest("base64url")}"`;
        this.res.setHeader("ETag", etag);
        if (this.raw.headers["if-none-match"] === etag) {
            this.finished = true;
            this.res.statusCode = 304;
            this.res.end();
            return;
        }

        this.finished = true;
        this.res.statusCode = status;
        this.res.setHeader("Content-Type", contentType);
        // HTML embeds a per-request CSRF token, nonce and theme; JSON and CSV
        // can contain account data. Neither may be stored by a shared cache.
        if (contentType.startsWith("text/html")) {
            this.res.setHeader("Cache-Control", "no-store");
        } else if (
            contentType.startsWith("application/json") ||
            contentType.startsWith("text/csv")
        ) {
            this.res.setHeader("Cache-Control", "private, no-store");
        } else if (this.res.getHeader("Set-Cookie")) {
            this.res.setHeader("Cache-Control", "no-store");
        }

        const bytes = Buffer.from(payload);
        const accept = String(this.raw.headers["accept-encoding"] ?? "");
        let body: Buffer = bytes;
        if (status !== 204 && bytes.length >= 1024 && accept) {
            if (accept.includes("br")) {
                body = brotliCompressSync(bytes, {
                    // Quality 4 keeps request-time compression cheap.
                    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
                });
                this.res.setHeader("Content-Encoding", "br");
            } else if (accept.includes("gzip")) {
                body = gzipSync(bytes, { level: 6 });
                this.res.setHeader("Content-Encoding", "gzip");
            }
            if (body !== bytes) this.res.setHeader("Vary", "Accept-Encoding");
        }
        this.res.setHeader("Content-Length", body.length);
        if (this.method === "HEAD") {
            this.res.end();
            return;
        }
        this.res.end(body);
    }

    /**
     * Double-submit CSRF support without editing every template: the token is
     * a cookie set by the middleware, injected into forms and exposed in a meta
     * tag for the XHR client. Hidden inputs are ignored by the parity checker.
     */
    private injectCsrf(html: string): string {
        if (!this.csrfToken) return html;
        const token = this.csrfToken.replace(/"/g, "&quot;");
        let out = html;
        if (out.includes("</head>") && !out.includes('name="csrf-token"')) {
            out = out.replace("</head>", `<meta name="csrf-token" content="${token}"/></head>`);
        }
        return out.replace(/<form\b[^>]*>/gi, (tag) => {
            if (tag.includes('name="_csrf"')) return tag;
            if (/\bmethod\s*=\s*["']?get\b/i.test(tag)) return tag;
            return `${tag}<input type="hidden" name="_csrf" value="${token}"/>`;
        });
    }

    /**
     * Every form control needs an accessible name. The templates already show
     * a label next to most of them but rarely wire it with `for`/`id`, and the
     * admin screens have hundreds of them. Derive the name once, here, from
     * the nearest preceding label text, then placeholder, then field name.
     */
    private injectAriaLabels(html: string): string {
        if (!html.includes("<form")) return html;
        return html.replace(
            /<(input|select|textarea)\b([^>]*)>/gi,
            (tag: string, _element: string, attrs: string, offset: number) => {
                if (/\b(aria-label|aria-labelledby)\b/i.test(attrs)) return tag;
                if (/\btype="(hidden|submit|button|reset|image)"/i.test(attrs)) return tag;
                const id = /\bid="([^"]+)"/i.exec(attrs)?.[1];
                if (id && html.includes(`for="${id}"`)) return tag;

                const before = html.slice(0, offset);
                const labelOpen = before.lastIndexOf("<label");
                const labelClose = before.lastIndexOf("</label>");
                // Already inside a wrapping <label>: the label text names it.
                if (labelOpen > labelClose) return tag;

                let text = "";
                if (labelClose !== -1 && offset - labelClose < 600) {
                    const gap = before.slice(labelClose);
                    // A control or another form between the label and this
                    // field means that label belongs to something else.
                    if (!/<(input|select|textarea|form)\b/i.test(gap)) {
                        text = before.slice(before.lastIndexOf("<label", labelClose), labelClose);
                    }
                }
                text = decodeLabel(text);
                if (!text) {
                    const placeholder = /\bplaceholder="([^"]*)"/i.exec(attrs)?.[1];
                    text = decodeLabel(placeholder ?? "");
                }
                if (!text) {
                    const name = /\bname="([^"]*)"/i.exec(attrs)?.[1];
                    text = (name ?? "").replace(/[_-]+/g, " ").trim();
                }
                if (!text) return tag;
                const safe = text.replace(/"/g, "&quot;").slice(0, 80);
                return tag.replace(/^<(\w+)/, `<$1 aria-label="${safe}"`);
            }
        );
    }
}

function decodeLabel(text: string): string {
    return text
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value; // malformed escape sequences stay literal instead of throwing
    }
}

function normalize(existing: number | string | string[] | undefined): string[] {
    if (!existing) return [];
    return Array.isArray(existing) ? existing : [String(existing)];
}
