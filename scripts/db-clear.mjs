#!/usr/bin/env node
import { rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

try {
    process.loadEnvFile();
} catch {
    /* real env wins */
}

function dbPath(key, fallback) {
    const raw = (process.env[key] ?? fallback).replace(/^file:/, "");
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

for (const file of [
    dbPath("DATABASE_URL_MAIN", "data/main.db"),
    dbPath("DATABASE_URL_WEB", "data/web.db"),
]) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
}
console.log("Databases removed.");
