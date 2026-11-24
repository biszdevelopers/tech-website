import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { isAbsolute, resolve } from "node:path";
import * as schema from "./schema-main";
import { createModel } from "./model-shim";

function absoluteDbPath(envKey: string, fallback: string): string {
    const raw = (process.env[envKey] ?? fallback).replace(/^file:/, "");
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

const sqlite = new Database(absoluteDbPath("DATABASE_URL_MAIN", "data/main.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("temp_store = MEMORY");
sqlite.pragma("cache_size = -20000");

const db = drizzle(sqlite, { schema });

export const mainSqlite = sqlite;

export const mainDb = {
    submission: createModel(db, schema.submission, { pk: "id" }),
    domains: createModel(db, schema.domains, { pk: "id" }),
    resources: createModel(db, schema.resources, { pk: "id" }),
    appMeta: createModel(db, schema.appMeta, { pk: "key" }),
    login: createModel(db, schema.login, { pk: "User" }),
    $disconnect: async () => sqlite.close(),
};

export type MainDb = typeof mainDb;
