/**
 * ============================================================================
 * CONFIG - ENVIRONMENT ACCESSOR
 * ============================================================================
 *
 * PURPOSE
 * One typed object that reads process.env exactly ONCE at boot and refuses to
 * start when something essential is missing or malformed. After this file runs,
 * the rest of the codebase never touches process.env again - it reads the
 * frozen `env` object below.
 *
 * WHY FAIL-CLOSED?
 * The previous codebase shipped with a hardcoded fallback session secret, so a
 * forgotten env var silently produced FORGEABLE sessions in production. The
 * rule now is the opposite: a missing secret is a boot-time crash whose message
 * tells you exactly how to fix it. Crashing at deploy beats getting hacked.
 *
 * LEARN: SINGLE SOURCE OF TRUTH
 * Reading this file answers "what configuration does this site support?" with
 * no other research. Add new settings here first; the compiler then guides you
 * to every call site that needs them.
 */

// Node 20.12+/24 can load .env without a dependency. Production may also use
// `node --env-file-if-exists=.env`, in which case this is a no-op.
if (!process.env.SESSION_SECRET) {
    try {
        process.loadEnvFile();
    } catch {
        // no .env file - rely on the real environment
    }
}

function requiredString(name: string, minLength = 1): string {
    const value = process.env[name];
    if (!value || value.length < minLength) {
        const suffix = minLength > 1 ? ` (min ${minLength} chars)` : "";
        throw new Error(
            `Missing environment variable ${name}${suffix}. Generate with: openssl rand -base64 32`
        );
    }
    if (isProd && /change-me|example|placeholder|test-secret/i.test(value)) {
        throw new Error(`${name} still contains a placeholder value. Generate a real secret.`);
    }
    return value;
}

/** Optional with a sane default; never throws for non-essential settings. */
function optionalNumber(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * THE configuration object. Imported everywhere, mutated nowhere (frozen).
 *
 * Session secrets are REQUIRED unconditionally - not just in production -
 * because a developer testing with forgeable cookies builds habits that
 * ship. The old code threw only when NODE_ENV=production; that gap is closed.
 */
const isProd = process.env.NODE_ENV === "production";
const port = optionalNumber("PORT", 3000);

function requiredInProd(name: string): string {
    const value = process.env[name]?.trim() ?? "";
    if (value) return value;
    if (isProd) {
        throw new Error(
            `Missing environment variable ${name}. Set it to the public origin, e.g. https://example.com`
        );
    }
    return `http://localhost:${port}`;
}

/** Parsed once: every URL/origin comparison uses the same canonical value. */
function parseSiteOrigin(): { value: string; https: boolean } {
    const raw = requiredInProd("SITE_ORIGIN").replace(/\/+$/, "");
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`SITE_ORIGIN must be an absolute URL, got "${raw}".`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`SITE_ORIGIN must use http or https, got "${raw}".`);
    }
    if (isProd && url.protocol !== "https:") {
        console.warn(
            "WARNING: SITE_ORIGIN is HTTP in production. Cookies will not be Secure and Stripe checkout should not be used."
        );
    }
    if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error(`SITE_ORIGIN must be an origin only (no path/query), got "${raw}".`);
    }
    return { value: url.origin, https: url.protocol === "https:" };
}

const site = parseSiteOrigin();
const tlsCert = process.env.TLS_CERT?.trim() || "";
const tlsKey = process.env.TLS_KEY?.trim() || "";
if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    throw new Error("TLS_CERT and TLS_KEY must be set together (or both left empty).");
}
const settingsKey = process.env.SETTINGS_KEY?.trim() || "";
if (settingsKey && Buffer.from(settingsKey, "base64").length !== 32) {
    throw new Error("SETTINGS_KEY must be a base64-encoded 32-byte key.");
}
if (isProd && site.https && !tlsCert && process.env.TRUST_PROXY !== "true") {
    throw new Error(
        "SITE_ORIGIN is https but the app has no TLS certificate and TRUST_PROXY is false. " +
            "Set TRUST_PROXY=true when nginx or another proxy terminates TLS, or provide TLS_CERT/TLS_KEY."
    );
}
if (isProd && !settingsKey) {
    console.warn(
        "WARNING: SETTINGS_KEY is not set. Stripe secrets will be stored unencrypted in SQLite."
    );
}

export const env = Object.freeze({
    isProd,
    port,
    host: process.env.HOST?.trim() || "0.0.0.0",

    /**
     * Canonical public origin. Redirects, Stripe URLs and CSRF checks use this
     * instead of the attacker-controlled Host header.
     */
    siteOrigin: site.value,
    /** True only when the public site is served over TLS. */
    isHttps: site.https,
    /** Trust X-Forwarded-For only when explicitly deployed behind a proxy. */
    trustProxy: process.env.TRUST_PROXY === "true",

    sessionSecretMain: requiredString("SESSION_SECRET", 32),
    sessionSecretWeb: requiredString("SESSION_SECRET_WEB", 32),
    /** Cookie lifetime in seconds - parity with the previous site (30 min). */
    sessionTtlSeconds: optionalNumber("SESSION_TTL_SECONDS", 1800),

    /** Runtime uploads live OUTSIDE dist/ so a build never deletes user data. */
    uploadsDir: process.env.UPLOADS_DIR?.trim() || "var/uploads",

    /** Optional in-process TLS. Leave both empty when a proxy terminates TLS. */
    tlsCert,
    tlsKey,

    /** Optional 32-byte base64 key for encrypting secrets stored in SQLite. */
    settingsKey,
});
