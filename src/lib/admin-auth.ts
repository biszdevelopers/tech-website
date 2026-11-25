import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SessionData } from "../core/05-session";
import { env } from "../config/env";

function constantTimeEquals(left: string, right: string): boolean {
    const a = createHash("sha256").update(left).digest();
    const b = createHash("sha256").update(right).digest();
    return timingSafeEqual(a, b);
}

export function adminUsernameMatches(value: string): boolean {
    return constantTimeEquals(value.trim().toLowerCase(), env.adminUsername.toLowerCase());
}

export function adminPasswordMatches(value: string): boolean {
    return constantTimeEquals(value, env.adminPassword);
}

/**
 * Fingerprint of the current .env credentials. Restarting with a different
 * password changes this number, so every old admin cookie stops verifying.
 */
export function adminSessionVersion(): number {
    return createHmac("sha256", env.sessionSecretMain)
        .update(`admin:${env.adminUsername}:${env.adminPassword}`)
        .digest()
        .readUIntBE(0, 6);
}

export function isMainAdminSession(session: SessionData | null): boolean {
    return Boolean(
        session?.islogin &&
        session.username &&
        session.username.toLowerCase() === env.adminUsername.toLowerCase() &&
        Number(session.sv ?? 0) === adminSessionVersion()
    );
}
