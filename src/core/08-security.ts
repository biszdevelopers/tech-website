/**
 * Headers, CSRF and rate limiting. These run before every route, so a new
 * endpoint cannot forget them.
 */

import { randomBytes } from "node:crypto";
import type { Context } from "./03-context";
import type { Middleware } from "./01-application";
import { rateLimit } from "../lib/rate-limit";
import { readMultipart, MAX_UPLOAD_BYTES } from "../lib/multipart";
import { env } from "../config/env";
import { HttpError } from "./09-errors";
import { createCsrfToken, verifyCsrfToken } from "../lib/csrf";

const CSRF_COOKIE = env.isHttps ? "__Host-csrf" : "csrf";
const CSRF_HEADER = "x-csrf-token";
const CSRF_EXEMPT = new Set(["/web/api/payments/stripe/webhook"]);
const MULTIPART_PATHS = new Set([
    "/api/submission",
    "/api/submission/screenshot",
    "/api/admin/create",
    "/api/admin/screenshot",
]);
const ASSET_PREFIXES = [
    "/js/",
    "/css/",
    "/fonts/",
    "/images/",
    "/web/images/",
    "/uploads/",
    "/testuploads/",
];

export function applySecurityHeaders(ctx: Context): void {
    const nonce = randomBytes(18).toString("base64");
    ctx.cspNonce = nonce;
    const h = ctx.res.setHeader.bind(ctx.res);
    h("X-Content-Type-Options", "nosniff");
    h("Referrer-Policy", "strict-origin-when-cross-origin");
    h("X-Frame-Options", "DENY");
    h("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    h("Cross-Origin-Opener-Policy", "same-origin");
    h("Cross-Origin-Resource-Policy", "same-origin");
    h("X-Crafted-By", "richie-rich90454");
    if (env.isProd && env.isHttps) {
        h("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
    h(
        "Content-Security-Policy",
        [
            "default-src 'self'",
            `script-src 'self' 'nonce-${nonce}'`,
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            "connect-src 'self'",
            "object-src 'none'",
            "frame-src 'none'",
            "media-src 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            env.isHttps ? "upgrade-insecure-requests" : "",
        ]
            .filter(Boolean)
            .join("; ")
    );
}

/** Parse an Origin/Referer value to its canonical scheme://host:port form. */
export function normalizeOrigin(value: string | undefined): string | null {
    if (!value) return null;
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

/** Origin the browser actually addressed, honoring a trusted proxy. */
function requestOrigin(ctx: Context): string | null {
    const hostHeader = env.trustProxy
        ? String(ctx.raw.headers["x-forwarded-host"] ?? ctx.raw.headers.host ?? "")
              .split(",")[0]
              .trim()
        : String(ctx.raw.headers.host ?? "");
    if (!hostHeader) return null;
    const forwardedProto = env.trustProxy
        ? String(ctx.raw.headers["x-forwarded-proto"] ?? "")
              .split(",")[0]
              .trim()
        : "";
    const socket = ctx.raw.socket as { encrypted?: boolean };
    const protocol = forwardedProto || (socket.encrypted ? "https" : "http");
    return normalizeOrigin(`${protocol}://${hostHeader}`);
}

/**
 * True when the request origin is the canonical origin, the host actually hit,
 * or the same host over a different scheme. The last case matters when TLS is
 * terminated before Node and the socket itself looks like plain HTTP.
 */
export function isAllowedOrigin(
    originHeader: string | undefined,
    actualOrigin: string | null,
    canonicalOrigin = normalizeOrigin(env.siteOrigin)
): boolean {
    if (!originHeader) return true;
    const origin = normalizeOrigin(originHeader);
    if (!origin) return false;
    if (canonicalOrigin && origin === canonicalOrigin) return true;
    if (!actualOrigin) return false;
    if (origin === actualOrigin) return true;
    try {
        return new URL(origin).host === new URL(actualOrigin).host;
    } catch {
        return false;
    }
}

/** A page request that can carry a form. Asset and API GETs do not get cookies. */
function isPagePath(path: string): boolean {
    if (path.startsWith("/api/") || path.startsWith("/web/api/")) return false;
    const last = path.slice(path.lastIndexOf("/") + 1);
    return last === "" || !last.includes(".");
}

function isAssetPath(path: string): boolean {
    return ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function csrfProtection(ctx: Context, next: () => Promise<void>): Promise<void> {
    const safe = ctx.method === "GET" || ctx.method === "HEAD" || ctx.method === "OPTIONS";
    const isApiClient = (): boolean => {
        if (String(ctx.raw.headers["sec-fetch-mode"] ?? "") === "navigate") return false;
        const accept = String(ctx.raw.headers.accept ?? "");
        return (
            !accept.includes("text/html") &&
            (ctx.path.startsWith("/api/") || ctx.path.startsWith("/web/api/"))
        );
    };

    if (safe && isAssetPath(ctx.path)) {
        await next();
        return;
    }

    let token = ctx.cookie(CSRF_COOKIE) ?? "";
    if (!verifyCsrfToken(token)) {
        token = createCsrfToken();
        if (safe && isPagePath(ctx.path)) {
            ctx.setCookie(CSRF_COOKIE, token, {
                httpOnly: true,
                secure: env.isHttps,
                sameSite: "Lax",
                maxAge: 60 * 60 * 24,
            });
        }
    }
    ctx.csrfToken = token;

    if (safe) {
        await next();
        return;
    }

    const normalizedPath = ctx.path.replace(/\/+$/, "") || "/";
    if (CSRF_EXEMPT.has(normalizedPath)) {
        await next();
        return;
    }

    const origin = ctx.raw.headers.origin ?? ctx.raw.headers.referer;
    if (!isAllowedOrigin(origin ? String(origin) : undefined, requestOrigin(ctx))) {
        ctx.throw(403, "Cross-origin request blocked.");
        return;
    }

    const declaredLength = Number(ctx.raw.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
        ctx.throw(413, "Upload too large.");
        return;
    }

    if (!rateLimit("csrf:" + ctx.ip, 240, 60_000)) {
        ctx.throw(429, "Too many requests. Try again later.");
        return;
    }

    const rejectCsrf = (): void => {
        if (normalizedPath === "/api/submission" && !isApiClient()) {
            ctx.redirect("/submission?error=csrf", 303);
            return;
        }
        ctx.throw(403, "Your form token expired. Reload the page and try again.");
    };

    const contentType = String(ctx.raw.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
        if (!MULTIPART_PATHS.has(normalizedPath)) {
            ctx.throw(415, "Unsupported multipart endpoint.");
            return;
        }
        try {
            await readMultipart(ctx);
        } catch (error) {
            if (error instanceof HttpError && error.status === 403) {
                rejectCsrf();
                return;
            }
            throw error;
        }
    } else {
        let provided = String(ctx.raw.headers[CSRF_HEADER] ?? "");
        if (!provided) {
            const body = await ctx.body();
            if (body && typeof body === "object") {
                provided = String((body as Record<string, unknown>)._csrf ?? "");
            }
        }
        if (!ctx.verifyCsrf(provided)) {
            rejectCsrf();
            return;
        }
        if (!ctx.cookie(CSRF_COOKIE)) {
            ctx.setCookie(CSRF_COOKIE, provided, {
                httpOnly: true,
                secure: env.isHttps,
                sameSite: "Lax",
                maxAge: 60 * 60 * 24,
            });
        }
    }

    await next();
}

export function limitRequests(bucketName: string, max: number, windowMs: number): Middleware {
    return async (ctx, next) => {
        if (!rateLimit(`${bucketName}:${ctx.ip}`, max, windowMs)) {
            ctx.json({ error: "Rate limit exceeded." }, 429);
            return;
        }
        await next();
    };
}

// Kept for callers that only need the page test.
export { isPagePath };
