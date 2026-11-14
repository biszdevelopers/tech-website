import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { HttpError } from "../core/09-errors";

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

function ipv4Private(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
}

function ipv6Private(ip: string): boolean {
    const value = ip.toLowerCase();
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
    if (value.startsWith("ff")) return true;
    if (value.startsWith("::ffff:")) return ipv4Private(value.slice(7));
    return false;
}

function isPrivateAddress(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) return ipv4Private(ip);
    if (version === 6) return ipv6Private(ip);
    return false;
}

/**
 * Target validation for the attack hub. Blocks literal private addresses,
 * local hostnames and DNS names that resolve into private space (the common
 * SSRF pivot). Redirects are disabled by the caller.
 */
export async function assertPublicTarget(raw: string): Promise<string> {
    const host = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!host || host.length > 253) throw new HttpError(400, "Invalid target host.");
    if (host.includes("/") || host.includes("@") || /\s/.test(host)) {
        throw new HttpError(400, "Invalid target host.");
    }
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
        throw new HttpError(400, "Target must be a public host.");
    }

    if (isIP(host)) {
        if (isPrivateAddress(host)) throw new HttpError(400, "Target must be a public host.");
        return host;
    }
    if (!HOSTNAME.test(host)) throw new HttpError(400, "Invalid target host.");

    let addresses: Array<{ address: string }>;
    try {
        addresses = await lookup(host, { all: true });
    } catch {
        throw new HttpError(400, "Target host could not be resolved.");
    }
    if (addresses.length === 0) throw new HttpError(400, "Target host could not be resolved.");
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new HttpError(400, "Target must resolve to a public address.");
    }
    return host;
}

/**
 * Fill a template from the database without letting user input change the
 * destination origin. Values are percent-encoded.
 */
export function buildAttackUrl(
    template: string,
    values: { host: string; port: string; time: string; method: string }
): string {
    let base: URL;
    try {
        base = new URL(template);
    } catch {
        throw new HttpError(500, "The selected API server has an invalid URL template.");
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
        throw new HttpError(500, "The selected API server must use http(s).");
    }
    const filled = template
        .replace(/\[host\]/gi, encodeURIComponent(values.host))
        .replace(/\[port\]/gi, encodeURIComponent(values.port))
        .replace(/\[time\]/gi, encodeURIComponent(values.time))
        .replace(/\[method\]/gi, encodeURIComponent(values.method));
    let result: URL;
    try {
        result = new URL(filled);
    } catch {
        throw new HttpError(500, "The API server URL template produced an invalid URL.");
    }
    if (result.origin !== base.origin) {
        throw new HttpError(500, "The API server URL template changed origin.");
    }
    return result.toString();
}

export function assertAllowedMethod(method: string, allowed: string[]): void {
    if (!allowed.some((m) => m.toUpperCase() === method.toUpperCase())) {
        throw new HttpError(400, "Unknown attack method.");
    }
}
