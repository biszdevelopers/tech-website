import type { Context } from "../core/03-context";
import { SessionManager } from "../core/05-session";
import { env } from "../config/env";
import { adminSessionVersion, isMainAdminSession } from "../lib/admin-auth";

export const mainSessions = new SessionManager(
    "main-session",
    env.sessionSecretMain,
    env.sessionTtlSeconds,
    env.isHttps,
    "Lax"
);

/** Main admin session, re-checked against the current .env credentials. */
export async function requireMainAdmin(ctx: Context): Promise<void> {
    const session = mainSessions.load(ctx);
    if (!isMainAdminSession(session)) {
        if (ctx.cookie(mainSessions.cookieName)) mainSessions.destroy(ctx);
        ctx.throw(404, "Page not found.");
    }
    mainSessions.save(ctx, {
        islogin: true,
        username: env.adminUsername,
        sv: adminSessionVersion(),
    });
}
