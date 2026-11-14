import { scryptSync, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

export interface PasswordCheck {
    ok: boolean;
    /** Present when a legacy hash verified and should be upgraded. */
    rehashed?: string;
}

/**
 * Verify bcrypt hashes and the legacy `salt:scryptHash` format produced by the
 * pre-v4 seed script. Successful legacy logins are transparently upgraded.
 */
export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
    if (!stored) return { ok: false };
    if (stored.startsWith("$2")) {
        return { ok: await bcrypt.compare(password, stored) };
    }
    const colon = stored.indexOf(":");
    if (colon > 0) {
        const salt = stored.slice(0, colon);
        const expected = Buffer.from(stored.slice(colon + 1), "hex");
        const actual = scryptSync(password, salt, 64);
        const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
        return ok ? { ok: true, rehashed: await bcrypt.hash(password, 12) } : { ok: false };
    }
    return { ok: false };
}
