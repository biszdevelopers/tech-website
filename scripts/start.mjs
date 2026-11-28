// Production entry point. `pnpm start` must behave like the systemd unit,
// otherwise a README-following boot runs with development defaults.
import { existsSync } from "node:fs";

process.env.NODE_ENV ||= "production";

if (!existsSync(new URL("../dist/server.js", import.meta.url))) {
    console.error("dist/server.js is missing. Run `pnpm run build` first.");
    process.exit(1);
}

try {
    await import("../dist/server.js");
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const configError =
        /SITE_ORIGIN|TRUST_PROXY|TLS_CERT|TLS_KEY|SESSION_SECRET|ADMIN_USERNAME|ADMIN_PASSWORD|Missing environment/.test(
            message
        );
    if (configError) {
        console.error(`\nConfiguration error:\n${message}`);
        console.error(
            "\nFix .env, then run `pnpm start` again. For a diagnosis run: pnpm run check:config -- --config-only"
        );
    } else {
        console.error(error);
    }
    process.exit(1);
}
