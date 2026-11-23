/**
 * ============================================================================
 * CORE MODULE 08 - SECURITY MIDDLEWARE
 * ============================================================================
 *
 * Headers, CSRF and rate limiting. These run before every route, so a new
 * endpoint cannot forget them.
 */

import { randomBytes } from "node:crypto";
import type { Context } from "./03-context";
import type { Middleware } from "./01-application";
import { rateLimit } from "../lib/rate-limit";
import { readMultipart } from "../lib/multipart";
import { env } from "../config/env";

const CSRF_COOKIE = "csrf";
const CSRF_HEADER = "x-csrf-token";
const CSRF_EXEMPT = new Set(["/web/api/payments/stripe/webhook"]);
const MULTIPART_PATHS = new Set(["/api/submission", "/api/admin/create", "/api/admin/screenshot"]);

export function applySecurityHeaders(ctx: Context): void {
    const h = ctx.res.setHeader.bind(ctx.res);
    h("X-Content-Type-Options", "nosniff");
    h("Referrer-Policy", "strict-origin-when-cross-origin");
    h("X-Frame-Options", "DENY");
    h("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    h("Cross-Origin-Opener-Policy", "same-origin");
    h("Cross-Origin-Resource-Policy", "same-origin");
    if (env.isProd) {
        h("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
    h(
        "Content-Security-Policy",
        [
            "default-src 'self'",
            "script-src 'self'",
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
            env.isProd ? "upgrade-insecure-requests" : "",
        ]
            .filter(Boolean)
            .join("; ")
    );
}

/**
 * Origin + double-submit CSRF protection.
 *
 * - Every state-changing request must echo the token from the `csrf` cookie,
 *   either as `_csrf` (form/multipart) or `x-csrf-token` (XHR/JSON).
 * - The Origin (or Referer fallback) must match the canonical SITE_ORIGIN or
 *   the origin the request was actually addressed to, so a reverse proxy,
 *   alias host or a stale SITE_ORIGIN can never lock every form out.
 * - Missing Origin is acceptable because the token is still mandatory; a
 *   browser form cannot read the HttpOnly cookie without the injected field.
 * - Only the signature-verified Stripe webhook is exempt.
 */
const ASSET_PREFIXES = ["/js/", "/css/", "/fonts/", "/images/", "/uploads/", "/testuploads/"];
const CANONICAL_ORIGIN = normalizeOrigin(env.siteOrigin);

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

/** True when the request origin is the canonical origin or the host it hit. */
export function isAllowedOrigin(
    originHeader: string | undefined,
    actualOrigin: string | null
): boolean {
    if (!originHeader) return true;
    const origin = normalizeOrigin(originHeader);
    if (!origin) return false;
    if (CANONICAL_ORIGIN && origin === CANONICAL_ORIGIN) return true;
    return actualOrigin !== null && origin === actualOrigin;
}

export async function csrfProtection(ctx: Context, next: () => Promise<void>): Promise<void> {
    const apiResponse = (): boolean => {
        const accept = String(ctx.raw.headers.accept ?? "");
        return (
            !accept.includes("text/html") &&
            (ctx.path.startsWith("/api/") || ctx.path.startsWith("/web/api/"))
        );
    };
    const deny = (status: number, message: string): void => {
        if (apiResponse()) ctx.json({ error: message }, status);
        else ctx.text(message, status);
    };

    // Static responses must stay cacheable and must not grow a Set-Cookie.
    if (
        (ctx.method === "GET" || ctx.method === "HEAD" || ctx.method === "OPTIONS") &&
        ASSET_PREFIXES.some((prefix) => ctx.path.startsWith(prefix))
    ) {
        await next();
        return;
    }
    let token = ctx.cookie(CSRF_COOKIE) ?? "";
    if (!/^[a-f0-9]{64}$/.test(token)) {
        token = randomBytes(32).toString("hex");
        ctx.setCookie(CSRF_COOKIE, token, {
            httpOnly: true,
            secure: env.isHttps,
            sameSite: "Lax",
            maxAge: 60 * 60 * 24,
        });
    }
    ctx.csrfToken = token;

    const safe = ctx.method === "GET" || ctx.method === "HEAD" || ctx.method === "OPTIONS";
    const normalizedPath = ctx.path.replace(/\/+$/, "") || "/";
    if (safe || CSRF_EXEMPT.has(normalizedPath)) {
        await next();
        return;
    }

    // Cheap flood guard BEFORE any body parse; route limits run later.
    if (!rateLimit("csrf:" + ctx.ip, 240, 60_000)) {
        deny(429, "Too many requests. Try again later.");
        return;
    }

    const origin = ctx.raw.headers.origin ?? ctx.raw.headers.referer;
    if (!isAllowedOrigin(origin ? String(origin) : undefined, requestOrigin(ctx))) {
        deny(403, "Cross-origin request blocked");
        return;
    }

    const contentType = String(ctx.raw.headers["content-type"] ?? "");
    if (contentType.includes("multipart/form-data")) {
        if (!MULTIPART_PATHS.has(normalizedPath)) {
            deny(415, "Unsupported multipart endpoint.");
            return;
        }
        // The parser verifies the token itself and memoizes the result so the
        // route can read the same fields without touching the stream again.
        await readMultipart(ctx);
    } else {
        let provided = String(ctx.raw.headers[CSRF_HEADER] ?? "");
        if (!provided) {
            const body = await ctx.body();
            if (body && typeof body === "object") {
                provided = String((body as Record<string, unknown>)._csrf ?? "");
            }
        }
        if (!ctx.verifyCsrf(provided)) {
            deny(403, "Invalid CSRF token");
            return;
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
