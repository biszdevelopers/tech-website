/**
 * ============================================================================
 * ROUTE GUARDS - the named gates referenced by RouteOptions.guard
 * ============================================================================
 *
 * PURPOSE
 * This file is the ONLY place that knows how "who are you?" maps to "are you
 * allowed?". The framework core stays storage-free; these functions plug the
 * session managers into the database and throw HttpError(401|403) on failure.
 * Route declarations then read like a security policy:
 *
 *   app.get('/admin', adminPage, { guard: 'mainAdmin' });
 *
 * LEARN: LIVE AUTHORIZATION
 * requireWebAdmin re-checks rank IN THE DATABASE on every request instead of
 * trusting the rank stored in the cookie. If an operator demotes or bans a
 * user, their existing cookie loses power IMMEDIATELY - no waiting for expiry.
 */

import type { Context } from "../core/03-context";
import { SessionManager, type SessionData } from "../core/05-session";
import { env } from "../config/env";
import { webDb } from "../lib/db/web";

export const mainSessions = new SessionManager(
    "main-session",
    env.sessionSecretMain,
    env.sessionTtlSeconds,
    env.isProd,
    "Strict"
);

export const webSessions = new SessionManager(
    "web-session",
    env.sessionSecretWeb,
    env.sessionTtlSeconds,
    env.isProd
);

/** Main-site admin session (public directory back office).
 *  Unauthenticated callers get the same 404 as an unknown URL: the back
 *  office must not be discoverable from the public site. */
export async function requireMainAdmin(ctx: Context): Promise<void> {
    const session = mainSessions.load(ctx);
    if (session?.islogin) return;
    ctx.throw(404, "Page not found.");
}

/**
 * Any authenticated web-app user. Handlers still do per-resource checks
 * (e.g. ticket ownership) - this gate only proves the person exists.
 */
export async function requireWebUser(ctx: Context): Promise<SessionData> {
    const session = webSessions.load(ctx);
    if (!session?.userId) ctx.throw(401, "Not authenticated.");
    return session;
}

/** Web-app administrator: rank >= 1, verified against the live user row.
 *  Non-admins see a 404, not a 403, so the admin area is not discoverable. */
export async function requireWebAdmin(ctx: Context): Promise<void> {
    const session = webSessions.load(ctx);
    if (!session?.userId) ctx.throw(404, "Page not found.");
    const user = await webDb.users.findUnique({
        where: { ID: session.userId },
        select: { rank: true },
    });
    if (!user || Number(user.rank) < 1) ctx.throw(404, "Page not found.");
}

/** Map consumed by Application - names used in route options resolve here. */
export const guards = {
    mainAdmin: requireMainAdmin,
    webAdmin: requireWebAdmin,
    webUser: async (ctx: Context): Promise<void> => {
        await requireWebUser(ctx);
    },
};
