import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env";

const PREFIX = "enc:v1:";

function key(): Buffer | null {
    if (!env.settingsKey) return null;
    try {
        const decoded = Buffer.from(env.settingsKey, "base64");
        return decoded.length === 32 ? decoded : null;
    } catch {
        return null;
    }
}

/** AES-256-GCM at rest. Plaintext values pass through when no key is set. */
export function sealSecret(value: string): string {
    const k = key();
    if (!k || !value) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", k, iv);
    const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function openSecret(value: string | null | undefined): string {
    if (!value) return "";
    if (!value.startsWith(PREFIX)) return value; // legacy plaintext
    const k = key();
    if (!k) return ""; // encrypted but key missing: fail closed
    try {
        const raw = Buffer.from(value.slice(PREFIX.length), "base64");
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const data = raw.subarray(28);
        const decipher = createDecipheriv("aes-256-gcm", k, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
        return "";
    }
}
