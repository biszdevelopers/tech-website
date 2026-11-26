import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

const TTL_MS = 60 * 60 * 1000;

function sign(payload: string): string {
    return createHmac("sha256", env.sessionSecretMain).update(payload).digest("hex");
}

/**
 * Short-lived proof that a browser just imported these pending submissions.
 * It lets the importer attach screenshots to its own new rows without an
 * account, and expires even if the browser tab stays open.
 */
export function createBulkUploadToken(ids: number[]): string {
    const payload = `${Date.now() + TTL_MS}:${ids.join(",")}`;
    return `${payload}.${sign(payload)}`;
}

export function verifyBulkUploadToken(token: string, id: number, now = Date.now()): boolean {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const colon = payload.indexOf(":");
    if (colon <= 0) return false;
    const expires = Number(payload.slice(0, colon));
    if (!Number.isSafeInteger(expires) || expires < now) return false;
    const ids = payload
        .slice(colon + 1)
        .split(",")
        .map(Number);
    if (!ids.includes(id)) return false;
    const expected = sign(payload);
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}
