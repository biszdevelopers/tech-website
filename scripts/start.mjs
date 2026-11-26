// Production entry point. `pnpm start` must behave like the systemd unit,
// otherwise a README-following boot runs with development defaults.
process.env.NODE_ENV ||= "production";

await import("../dist/server.js");
