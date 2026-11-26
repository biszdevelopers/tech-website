import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

const TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/;

function sign(payload: string): string {
    return createHmac("sha256", env.sessionSecretMain).update(payload).digest("hex");
}

export function createCsrfToken(now = Date.now()): string {
    const expiry = String(now + TTL_MS);
    const nonce = randomBytes(16).toString("hex");
    const payload = `${expiry}.${nonce}`;
    return `${payload}.${sign(payload)}`;
}

export function verifyCsrfToken(token: string, now = Date.now()): boolean {
    const match = TOKEN_RE.exec(token);
    if (!match) return false;
    const expiry = Number(match[1]);
    if (!Number.isSafeInteger(expiry) || expiry < now) return false;
    const expected = sign(`${match[1]}.${match[2]}`);
    const actual = match[3];
    return (
        expected.length === actual.length &&
        timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
    );
}
