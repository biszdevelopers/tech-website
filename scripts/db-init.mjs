#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

try {
    process.loadEnvFile();
} catch {
    /* real env wins */
}

function dbPath(key, fallback) {
    const raw = (process.env[key] ?? fallback).replace(/^file:/, "");
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

const files = [
    dbPath("DATABASE_URL_MAIN", "data/main.db"),
    dbPath("DATABASE_URL_WEB", "data/web.db"),
];
for (const file of files) mkdirSync(dirname(file), { recursive: true });

for (const config of ["drizzle.main.config.ts", "drizzle.web.config.ts"]) {
    const result = spawnSync(
        "pnpm",
        ["exec", "drizzle-kit", "push", `--config=${config}`, "--force"],
        { stdio: "inherit", env: process.env, shell: process.platform === "win32" }
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Database schema is up to date.");
