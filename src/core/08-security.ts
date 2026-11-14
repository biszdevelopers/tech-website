/**
 * ============================================================================
 * CORE MODULE 08 - SECURITY MIDDLEWARE
 * ============================================================================
 *
 * Headers, CSRF and rate limiting. These run before every route, so a new
 * endpoint cannot forget them.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "./03-context";
import type { Middleware } from "./01-application";
import { rateLimit } from "../lib/rate-limit";
import { env } from "../config/env";

const CSRF_COOKIE = "csrf";
const CSRF_HEADER = "x-csrf-token";
const CSRF_EXEMPT = new Set(["/web/api/payments/stripe/webhook"]);

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
 * - Every cross-site state-changing request is refused by Origin comparison
 *   against the canonical SITE_ORIGIN (not the attacker-controlled Host).
 * - Requests carrying a session cookie must also echo the per-request token
 *   from the `csrf` cookie in `_csrf` or `x-csrf-token`.
 * - Multipart uploads are exempt from the token echo because the token cannot
 *   be read without consuming the stream; Origin + SameSite still apply.
 */
const ASSET_PREFIXES = ["/js/", "/css/", "/fonts/", "/images/", "/uploads/", "/testuploads/"];

export async function csrfProtection(ctx: Context, next: () => Promise<void>): Promise<void> {
    // Static responses must stay cacheable and must not grow a Set-Cookie.
    if (ASSET_PREFIXES.some((prefix) => ctx.path.startsWith(prefix))) {
        await next();
        return;
    }
    let token = ctx.cookie(CSRF_COOKIE) ?? "";
    if (!/^[a-f0-9]{64}$/.test(token)) {
        token = randomBytes(32).toString("hex");
        ctx.setCookie(CSRF_COOKIE, token, {
            httpOnly: true,
            secure: env.isProd,
            sameSite: "Lax",
            maxAge: 60 * 60 * 24,
        });
    }
    ctx.csrfToken = token;

    const safe = ctx.method === "GET" || ctx.method === "HEAD" || ctx.method === "OPTIONS";
    if (safe || CSRF_EXEMPT.has(ctx.path)) {
        await next();
        return;
    }

    const origin = ctx.raw.headers.origin ?? ctx.raw.headers.referer;
    if (origin) {
        try {
            if (new URL(origin).origin !== env.siteOrigin) {
                ctx.text("Cross-origin request blocked", 403);
                return;
            }
        } catch {
            ctx.text("Invalid Origin header", 403);
            return;
        }
    }

    if (ctx.hasAuthCookie()) {
        const contentType = String(ctx.raw.headers["content-type"] ?? "");
        let provided = String(ctx.raw.headers[CSRF_HEADER] ?? "");
        if (!provided && !contentType.includes("multipart/form-data")) {
            const body = await ctx.body();
            if (body && typeof body === "object") {
                provided = String((body as Record<string, unknown>)._csrf ?? "");
            }
        }
        if (!safeEqual(provided, token)) {
            ctx.text("Invalid CSRF token", 403);
            return;
        }
    }

    await next();
}

function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
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
