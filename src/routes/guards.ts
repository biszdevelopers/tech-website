/**
 * Route guards. Authentication maps to authorization here, never in handlers.
 */
import type { Context } from "../core/03-context";
import { SessionManager, type SessionData } from "../core/05-session";
import { env } from "../config/env";
import { webDb } from "../lib/db/web";
import { mainDb } from "../lib/db/main";
import type { UserRow } from "../types/db";

export const mainSessions = new SessionManager(
    "main-session",
    env.sessionSecretMain,
    env.sessionTtlSeconds,
    env.isHttps,
    "Lax"
);

export const webSessions = new SessionManager(
    "web-session",
    env.sessionSecretWeb,
    env.sessionTtlSeconds,
    env.isHttps,
    "Lax"
);

/** Main admin session, re-checked against the login row every request. */
export async function requireMainAdmin(ctx: Context): Promise<void> {
    const session = mainSessions.load(ctx);
    if (!session?.islogin) ctx.throw(404, "Page not found.");
    const row = await mainDb.login.findFirst();
    if (!row) ctx.throw(404, "Page not found.");
    if (Number(session.sv ?? 0) !== Number(row.sessionVersion)) {
        mainSessions.destroy(ctx);
        ctx.throw(404, "Page not found.");
    }
    mainSessions.save(ctx, {
        islogin: true,
        username: row.User,
        sv: Number(row.sessionVersion),
    });
}

/** Optional web user. Invalid, banned or stale sessions become anonymous. */
export async function optionalWebUser(ctx: Context): Promise<UserRow | null> {
    const session = webSessions.load(ctx);
    if (!session?.userId) return null;
    const user = await webDb.users.findUnique({ where: { ID: session.userId } });
    if (!user || Number(user.status) === 1) {
        webSessions.destroy(ctx);
        return null;
    }
    if (Number(session.sv ?? 0) !== Number(user.sessionVersion)) {
        webSessions.destroy(ctx);
        return null;
    }
    webSessions.save(ctx, {
        userId: Number(user.ID),
        username: user.username,
        rank: Number(user.rank),
        sv: Number(user.sessionVersion),
    });
    return user as UserRow;
}

/** Any authenticated web user. Handlers still perform resource ownership checks. */
export async function requireWebUser(ctx: Context): Promise<SessionData> {
    const user = await optionalWebUser(ctx);
    if (!user) ctx.throw(401, "Not authenticated.");
    return {
        userId: Number(user.ID),
        username: user.username,
        rank: Number(user.rank),
        sv: Number(user.sessionVersion),
    };
}

/** Web admin: rank >= 1, live-checked. Unauthorized callers see 404. */
export async function requireWebAdmin(ctx: Context): Promise<void> {
    const user = await optionalWebUser(ctx);
    if (!user || Number(user.rank) < 1) ctx.throw(404, "Page not found.");
}

export const guards = {
    mainAdmin: requireMainAdmin,
    webAdmin: requireWebAdmin,
    webUser: async (ctx: Context): Promise<void> => {
        await requireWebUser(ctx);
    },
};
