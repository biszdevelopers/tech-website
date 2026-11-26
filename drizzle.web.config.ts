import type { Config } from "drizzle-kit";

const raw = process.env.DATABASE_URL_WEB?.trim() || "file:./data/web.db";

export default {
    dialect: "sqlite",
    schema: "./src/lib/db/schema-web.ts",
    out: "./drizzle/web",
    dbCredentials: { url: raw.replace(/^file:/, "") },
} satisfies Config;
