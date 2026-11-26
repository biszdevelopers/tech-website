/**
 * Route guards. Authentication maps to authorization here, never in handlers.
 */
import type { Context } from "../core/03-context";
import { SessionManager, type SessionData } from "../core/05-session";
import { env } from "../config/env";
import { webDb } from "../lib/db/web";
import { mainSessions, requireMainAdmin } from "./main-guard";
import type { UserRow } from "../types/db";

export { mainSessions, requireMainAdmin };

export const webSessions = new SessionManager(
    "web-session",
    env.sessionSecretWeb,
    env.sessionTtlSeconds,
    env.isHttps,
    "Lax"
);

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
