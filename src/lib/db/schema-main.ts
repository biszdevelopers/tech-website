import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

// Mirrors the live SQLite schema. Column names are explicit so every consumer
// sees the same casing the database uses.
export const submission = sqliteTable(
    "submission",
    {
        id: integer("id").primaryKey(),
        techname: text("techname").notNull().default(""),
        tl1_desc: text("tl1_desc").notNull().default(""),
        tl2_desc: text("tl2_desc").notNull().default(""),
        tl3_desc: text("tl3_desc").notNull().default(""),
        tl4_desc: text("tl4_desc").notNull().default(""),
        tl5_desc: text("tl5_desc").notNull().default(""),
        tl6_desc: text("tl6_desc").notNull().default(""),
        link: text("link").notNull().default(""),
        displaytext: text("displaytext").notNull().default(""),
        accepted: integer("accepted", { mode: "boolean" }).notNull().default(false),
        username: text("username").notNull().default(""),
        contact: text("contact").notNull().default(""),
        updatedAt: integer("updatedAt").notNull().default(0),
    },
    (t) => [index("submission_accepted_id").on(t.accepted, t.id)]
);

export const domains = sqliteTable("domains", {
    id: integer("id").primaryKey(),
    R: integer("R", { mode: "boolean" }).notNull().default(false),
    TP: integer("TP", { mode: "boolean" }).notNull().default(false),
    MT: integer("MT", { mode: "boolean" }).notNull().default(false),
    AR: integer("AR", { mode: "boolean" }).notNull().default(false),
    U: integer("U", { mode: "boolean" }).notNull().default(false),
    MDL: integer("MDL", { mode: "boolean" }).notNull().default(false),
    RA: integer("RA", { mode: "boolean" }).notNull().default(false),
    RoTech: integer("RoTech", { mode: "boolean" }).notNull().default(false),
    LS: integer("LS", { mode: "boolean" }).notNull().default(false),
    RoThink: integer("RoThink", { mode: "boolean" }).notNull().default(false),
    EoST: integer("EoST", { mode: "boolean" }).notNull().default(false),
    EF: integer("EF", { mode: "boolean" }).notNull().default(false),
    RTE: integer("RTE", { mode: "boolean" }).notNull().default(false),
    DLoI: integer("DLoI", { mode: "boolean" }).notNull().default(false),
    RaAoC: integer("RaAoC", { mode: "boolean" }).notNull().default(false),
});

export const resources = sqliteTable(
    "resources",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        submissionId: integer("submissionId").notNull(),
        label: text("label").notNull().default(""),
        url: text("url").notNull().default(""),
        sort: integer("sort").notNull().default(0),
    },
    (t) => [index("resources_submission_sort").on(t.submissionId, t.sort)]
);

export const appMeta = sqliteTable("app_meta", {
    key: text("key").primaryKey(),
    value: text("value").notNull().default(""),
});

export const login = sqliteTable("login", {
    User: text("User").primaryKey(),
    PW: text("PW").notNull().default(""),
    sessionVersion: integer("sessionVersion").notNull().default(0),
});
