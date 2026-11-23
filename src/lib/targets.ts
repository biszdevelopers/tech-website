import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { HttpError } from "../core/09-errors";

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Everything that must never be reachable through the attack API: loopback,
// RFC1918, CGNAT, link-local, documentation, multicast/reserved, and the IPv6
// equivalents including mapped/NAT64/6to4 forms.
const blocked = new BlockList();
for (const [base, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as Array<[string, number]>) {
    blocked.addSubnet(base, prefix, "ipv4");
}
for (const [base, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as Array<[string, number]>) {
    blocked.addSubnet(base, prefix, "ipv6");
}

function isPrivateAddress(ip: string): boolean {
    const value = ip.toLowerCase();
    if (value === "::" || value === "::1") return true;
    // IPv4-mapped/compatible forms must be judged by their IPv4 part. Adding
    // ::ffff:0:0/96 to the block list would (incorrectly) block every IPv4.
    const mapped = /^::(?:ffff:)?(.+)$/.exec(value);
    if (mapped) {
        const tail = mapped[1];
        if (tail.includes(".")) return isPrivateAddress(tail);
        const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
        if (hex) {
            const high = parseInt(hex[1], 16);
            const low = parseInt(hex[2], 16);
            const v4 = [high >> 8, high & 255, low >> 8, low & 255].join(".");
            return isPrivateAddress(v4);
        }
    }
    const version = isIP(ip);
    if (!version) return true;
    try {
        return blocked.check(ip, version === 4 ? "ipv4" : "ipv6");
    } catch {
        return true; // unparsable address is never a valid public target
    }
}

/**
 * Target validation for the attack hub. Blocks literal private addresses,
 * local hostnames and DNS names that resolve into private space (the common
 * SSRF pivot). Redirects are disabled by the caller.
 */
export async function assertPublicTarget(raw: string): Promise<string> {
    const host = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!host || host.length > 253) throw new HttpError(400, "Invalid target host.");
    if (host.includes("/") || host.includes("@") || host.includes("%") || /\s/.test(host)) {
        throw new HttpError(400, "Invalid target host.");
    }
    // Reject octal/hex-looking IPv4 (0177.0.0.1, 0x7f.0.0.1) before DNS can
    // reinterpret it as loopback.
    if (/^[0-9a-fx.]+$/i.test(host) && !IPV4.test(host) && !isIP(host)) {
        throw new HttpError(400, "Invalid target host.");
    }
    if (
        host === "localhost" ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".home.arpa")
    ) {
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
