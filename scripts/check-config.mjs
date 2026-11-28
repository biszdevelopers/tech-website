#!/usr/bin/env node
/**
 * Deployment preflight. Validates the values that commonly break a production
 * launch, then checks the local health endpoint unless --config-only is used.
 *
 *   pnpm run check:config
 *   pnpm run check:config -- --config-only
 *   pnpm run check:config -- --public
 */
import http from "node:http";
import https from "node:https";

try {
    process.loadEnvFile();
} catch {
    /* real env wins */
}

const args = new Set(process.argv.slice(2));
const configOnly = args.has("--config-only");
const checkPublic = args.has("--public");
const isProd = (process.env.NODE_ENV || "production") === "production";
const errors = [];
const warnings = [];

const rawPort = process.env.PORT || "3000";
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be an integer from 1 to 65535, got "${rawPort}".`);
}

const rawOrigin = (process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
let origin = null;
let originPort = null;
if (!rawOrigin) {
    errors.push("SITE_ORIGIN is missing. Set it to the public origin, e.g. https://example.com.");
} else {
    try {
        origin = new URL(rawOrigin);
        if (origin.pathname !== "/" || origin.search || origin.hash) {
            errors.push("SITE_ORIGIN must be an origin only, with no path, query or hash.");
        }
        if (origin.protocol !== "http:" && origin.protocol !== "https:") {
            errors.push(`SITE_ORIGIN must use http or https, got "${rawOrigin}".`);
        }
        if (isProd && origin.protocol !== "https:") {
            warnings.push(
                "SITE_ORIGIN is HTTP in production. Use HTTPS for real accounts, payments and Secure cookies."
            );
        }
        originPort = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
    } catch {
        errors.push(`SITE_ORIGIN is not an absolute URL: "${rawOrigin}".`);
    }
}

const rawPublicPort = process.env.PUBLIC_PORT?.trim() || (originPort ? String(originPort) : "");
const publicPort = Number(rawPublicPort);
if (!Number.isSafeInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    errors.push(`PUBLIC_PORT must be an integer from 1 to 65535, got "${rawPublicPort}".`);
} else if (originPort !== null && publicPort !== originPort) {
    errors.push(
        `PUBLIC_PORT is ${publicPort} but SITE_ORIGIN uses ${originPort}. Use the same public port in both settings.`
    );
}

const trustProxy = process.env.TRUST_PROXY === "true";
const tlsCert = (process.env.TLS_CERT || "").trim();
const tlsKey = (process.env.TLS_KEY || "").trim();
const hasTls = Boolean(tlsCert || tlsKey);

if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    errors.push("TLS_CERT and TLS_KEY must be set together, or both left empty.");
}
if (origin?.protocol === "https:" && !hasTls && !trustProxy) {
    errors.push(
        "SITE_ORIGIN is HTTPS but the app has no TLS certificate and TRUST_PROXY is not true. " +
            "Set TRUST_PROXY=true in .env when nginx, Cloudflare, a hosting panel or another proxy terminates TLS; " +
            "for direct Node HTTPS set TLS_CERT and TLS_KEY to the fullchain and private-key file paths."
    );
}
if (origin?.protocol === "https:" && hasTls) {
    const originPort = Number(origin.port || 443);
    if (originPort !== port) {
        warnings.push(
            `Direct HTTPS listens on PORT ${port} but SITE_ORIGIN uses ${originPort}. ` +
                `Use https://${origin.hostname}:${port} or forward ${originPort} to ${port}.`
        );
    }
}
if (origin?.protocol === "https:" && !hasTls && trustProxy) {
    console.log("TLS is terminated before Node; PORT is the internal proxy target.");
    if (port !== publicPort) {
        console.log(`The proxy/panel must forward public port ${publicPort} to 127.0.0.1:${port}.`);
    }
    const cloudflarePorts = new Set([
        80, 443, 8080, 8443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8880,
    ]);
    if (!cloudflarePorts.has(port)) {
        warnings.push(
            `PORT ${port} is not a default Cloudflare origin port. It can work through an active ` +
                `Origin Rule (destination ports may be 1-65535); verify the rule and allow TCP ${port} from Cloudflare.`
        );
    }
}
if (origin?.protocol === "https:" && trustProxy && hasTls) {
    warnings.push(
        "TRUST_PROXY=true and TLS_CERT/TLS_KEY are both set; decide which layer terminates TLS."
    );
}

function secret(name, min) {
    const value = process.env[name] || "";
    if (value.length < min) {
        errors.push(`${name} must be at least ${min} characters.`);
    }
    if (isProd && /change-me|example|placeholder|test-secret/i.test(value)) {
        errors.push(`${name} still contains a placeholder value.`);
    }
}

secret("SESSION_SECRET", 32);
secret("SESSION_SECRET_WEB", 32);
const adminUser = process.env.ADMIN_USERNAME || "";
if (!/^[A-Za-z0-9._-]{3,20}$/.test(adminUser)) {
    errors.push(
        "ADMIN_USERNAME must be 3-20 characters using letters, digits, dot, dash or underscore."
    );
}
const adminPass = process.env.ADMIN_PASSWORD || "";
if (adminPass.length < 10) {
    errors.push("ADMIN_PASSWORD must be at least 10 characters.");
}
if (isProd && adminPass.length < 12) {
    warnings.push("ADMIN_PASSWORD is short. Use 16+ random characters for the directory operator.");
}

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
if (origin && localHosts.has(origin.hostname)) {
    const originPort = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
    if (originPort !== port) {
        errors.push(
            `SITE_ORIGIN uses port ${originPort} but PORT is ${port}. ` +
                "For a same-machine origin, keep both on the same port."
        );
    }
}

console.log("==> Configuration");
console.log(`NODE_ENV       ${process.env.NODE_ENV || "production (default)"}`);
console.log(`PORT           ${rawPort} (internal listener)`);
console.log(`PUBLIC_PORT    ${rawPublicPort} (browser/Cloudflare)`);
console.log(`HOST           ${process.env.HOST || "0.0.0.0"}`);
console.log(`SITE_ORIGIN    ${rawOrigin || "(missing)"}`);
console.log(`TRUST_PROXY    ${trustProxy}`);
console.log(`TLS            ${hasTls ? "configured" : "not configured"}`);
console.log(`ADMIN_USERNAME ${adminUser || "(missing)"}`);

for (const message of warnings) console.warn(`WARN  ${message}`);
for (const message of errors) console.error(`ERROR ${message}`);

if (errors.length > 0) {
    console.error("\nFix .env before starting the server.");
    process.exit(1);
}

function checkHealth(url, allowSelfSigned, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.get(
            url,
            { rejectUnauthorized: !allowSelfSigned, timeout: timeoutMs },
            (res) => {
                res.resume();
                const server = res.headers.server ? ` ${res.headers.server}` : "";
                const ray = res.headers["cf-ray"] ? ` cf-ray ${res.headers["cf-ray"]}` : "";
                resolve({
                    ok: res.statusCode === 200,
                    detail: `HTTP ${res.statusCode}${server}${ray}`,
                });
            }
        );
        req.on("timeout", () => {
            req.destroy();
            resolve({ ok: false, detail: `timeout after ${timeoutMs}ms` });
        });
        req.on("error", (error) => resolve({ ok: false, detail: error.message }));
    });
}

if (!configOnly) {
    const scheme = hasTls ? "https" : "http";
    const localUrl = new URL(`${scheme}://127.0.0.1:${port}/api/health`);
    const result = await checkHealth(localUrl, true);
    if (result.ok) console.log(`PASS  local health ${localUrl.href}`);
    else {
        console.error(`FAIL  local health ${localUrl.href} (${result.detail})`);
        console.error(
            "      Is the service running? Check: journalctl -u tech-website -n 80 --no-pager"
        );
    }

    if (checkPublic && origin) {
        const publicUrl = new URL("/api/health", origin);
        const publicResult = await checkHealth(publicUrl, false, 30000);
        if (publicResult.ok) console.log(`PASS  public health ${publicUrl.href}`);
        else {
            console.error(`FAIL  public health ${publicUrl.href} (${publicResult.detail})`);
            if (/timeout|ECONN|ENOTFOUND|EAI_AGAIN/.test(publicResult.detail)) {
                console.error(
                    "      Cloudflare could not reach the origin. Check the origin firewall, " +
                        "the Origin Rule destination port, the origin A/AAAA record, IPv4/IPv6 binding, and SSL/TLS mode."
                );
            } else if (/HTTP 52[1-4]/.test(publicResult.detail)) {
                console.error(
                    "      Cloudflare reached its edge but not the origin. Open the app port to " +
                        "Cloudflare and verify the Origin Rule destination port."
                );
            } else if (/HTTP 52[5-6]/.test(publicResult.detail)) {
                console.error(
                    "      TLS handshake failed between Cloudflare and the origin. For an HTTP " +
                        "origin set SSL/TLS mode to Flexible; otherwise install a Cloudflare Origin Certificate."
                );
            } else if (/HTTP 403/.test(publicResult.detail)) {
                console.error("      Cloudflare or a WAF rule blocked the health request.");
            }
        }
    }

    if (origin) {
        console.log("\n==> Origin checklist");
        console.log(`App origin: http://127.0.0.1:${port}`);
        console.log(`Cloudflare public port: ${publicPort}`);
        console.log(
            `Origin Rule destination port must be ${port}; Cloudflare's built-in origin ports are 80/443/8080/8443 and their alternates.`
        );
        console.log(
            `Allow inbound TCP ${port} from Cloudflare IP ranges (or use a Cloudflare Tunnel).`
        );
        console.log(
            "Set Cloudflare SSL/TLS mode to match the origin: Flexible for HTTP, Full (strict) for HTTPS."
        );
        console.log("Optional nginx proxy_pass (if used): http://127.0.0.1:" + port + ";");
        console.log(
            "Optional nginx headers: Host $host, X-Forwarded-Proto $scheme, X-Forwarded-For $proxy_add_x_forwarded_for."
        );
    }
}
