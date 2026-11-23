import type { Config } from "drizzle-kit";

const raw = process.env.DATABASE_URL_MAIN?.trim() || "file:./data/main.db";

export default {
    dialect: "sqlite",
    schema: "./src/lib/db/schema-main.ts",
    out: "./drizzle/main",
    dbCredentials: { url: raw.replace(/^file:/, "") },
} satisfies Config;
