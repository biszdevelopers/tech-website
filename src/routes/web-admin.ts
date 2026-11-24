/**
 * WEB ADMIN ROUTES - every /web/admin/* page + CRUD API.
 * All routes carry the webAdmin guard. Data mutations follow the legacy
 * action=create/update/delete protocol via hidden form fields.
 */

import { Application } from "../core/01-application";
import { HttpError } from "../core/09-errors";
import { webDb, webSqlite, expireFinishedAttacks } from "../lib/db/web";
import { render } from "../core/views";
import { webSessions } from "./guards";
import { launchAttack } from "../server/attacks";
import { features } from "../config/features";
import { withLock } from "../lib/lock";
import { sealSecret } from "../lib/secrets";
import { invalidateWebSettings } from "../lib/web-settings";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

type Body = Record<string, unknown>;

const PLAN_TERM_MAX = 10_000;
const EXPIRY_MAX = 9_999_999_999;

function actor(ctx: { cookie: (name: string) => string | undefined }): string {
    return webSessions.load(ctx as never)?.username ?? "admin";
}

async function audit(
    ctx: Parameters<typeof actor>[0],
    action: string,
    target: string
): Promise<void> {
    await webDb.actions.create({
        data: {
            admin: actor(ctx),
            client: target,
            action,
            date: Math.floor(Date.now() / 1000),
        },
    });
}

async function actorIsSuper(ctx: Parameters<typeof actor>[0]): Promise<boolean> {
    const session = webSessions.load(ctx as never);
    if (!session?.userId) return false;
    const row = await webDb.users.findUnique({
        where: { ID: session.userId },
        select: { rank: true },
    });
    return Number(row?.rank ?? 0) >= 2;
}

function str(body: Body, key: string, fallback = ""): string {
    return String(body[key] ?? fallback);
}

function intValue(
    body: Body,
    key: string,
    min: number,
    max: number,
    label: string,
    fallback?: number
): number {
    const raw = body[key] ?? fallback;
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value < min || value > max) {
        throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}.`);
    }
    return value;
}

/** Usernames are unique case-insensitively; SQLite's UNIQUE is not. */
function usernameTaken(username: string, exceptId = 0): boolean {
    const row = webSqlite
        .prepare("select ID from users where lower(username) = lower(?) limit 1")
        .get(username) as { ID?: number } | undefined;
    return Boolean(row?.ID && Number(row.ID) !== exceptId);
}

async function requirePlan(planId: number): Promise<void> {
    if (!Number.isInteger(planId) || planId < 0) throw new HttpError(400, "Invalid plan id.");
    if (planId === 0) return;
    const plan = await webDb.plans.findUnique({ where: { ID: planId }, select: { ID: true } });
    if (!plan) throw new HttpError(400, "That plan does not exist.");
}

function planPayload(body: Body) {
    const name = str(body, "name").trim();
    if (!name || name.length > 60) {
        throw new HttpError(400, "Plan name must be 1-60 characters.");
    }
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new HttpError(400, "Plan price must be greater than 0.");
    }
    const unit = str(body, "unit", "days") || "days";
    if (unit !== "days" && unit !== "hours") {
        throw new HttpError(400, "Plan unit must be days or hours.");
    }
    return {
        name,
        price: Math.round(price * 100) / 100,
        length: intValue(body, "length", 1, PLAN_TERM_MAX, "Plan length"),
        mbt: intValue(body, "mbt", 1, 3600, "Max attack time"),
        concurrents: intValue(body, "concurrents", 1, 1000, "Concurrent attacks"),
        vip: Number(body.vip) === 1 ? 1 : 0,
        unit,
        private: Number(body.private) === 1 ? 1 : 0,
    };
}

function methodPayload(body: Body) {
    const name = str(body, "name").trim();
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name)) {
        throw new HttpError(400, "Method name must be 2-32 letters, numbers, dots or dashes.");
    }
    const fullname = str(body, "fullname").trim();
    if (!fullname || fullname.length > 100) {
        throw new HttpError(400, "Method full name must be 1-100 characters.");
    }
    const type = str(body, "type");
    if (type !== "layer4" && type !== "layer7") {
        throw new HttpError(400, "Method type must be layer4 or layer7.");
    }
    const command = str(body, "command").trim();
    if (!command || command.length > 500) {
        throw new HttpError(400, "Method command must be 1-500 characters.");
    }
    return { name, fullname, type, command };
}

async function serverPayload(body: Body) {
    const name = str(body, "name").trim();
    if (!name || name.length > 60) {
        throw new HttpError(400, "Server name must be 1-60 characters.");
    }
    const apiUrl = str(body, "api").trim();
    if (!apiUrl) {
        throw new HttpError(400, "API URL template is required.");
    }
    if (!/^https?:\/\//i.test(apiUrl)) {
        throw new HttpError(400, "API URL must start with http:// or https://.");
    }
    try {
        new URL(apiUrl);
    } catch {
        throw new HttpError(400, "API URL is invalid.");
    }
    const slots = intValue(body, "slots", 1, 100_000, "Slots");
    const rawMethods = str(body, "methods").trim();
    const tokens = rawMethods
        ? rawMethods
              .split(",")
              .map((token) => token.trim())
              .filter(Boolean)
        : [];
    const known = (await webDb.methods.findMany({ select: { name: true } })) as Array<{
        name: string;
    }>;
    const canonical: string[] = [];
    for (const token of tokens) {
        const match = known.find((m) => m.name.toLowerCase() === token.toLowerCase());
        if (!match) throw new HttpError(400, `Unknown method: ${token}.`);
        if (!canonical.includes(match.name)) canonical.push(match.name);
    }
    if (canonical.length === 0) {
        throw new HttpError(400, "Select at least one method for this server.");
    }
    return {
        name,
        api: apiUrl,
        slots,
        methods: canonical.join(","),
        vip: Number(body.vip) === 1 ? 1 : 0,
    };
}

function planTerm(plan: { length: number; unit: string }): number {
    return Math.max(Number(plan.length) || 0, 1) * (plan.unit === "hours" ? 3600 : 86400);
}

export function registerWebAdminRoutes(app: Application): void {
    app.get(
        "/web/admin/dashboard",
        async (ctx) => {
            expireFinishedAttacks();
            const [totalUsers, activeUsers, totalAttacks, runningAttacks, waitingTickets] =
                await Promise.all([
                    webDb.users.count(),
                    webDb.users.count({
                        where: {
                            membership: { not: 0 },
                            expire: { gt: Math.floor(Date.now() / 1000) },
                        },
                    }),
                    webDb.logs.count(),
                    webDb.logs.count({ where: { stopped: 0, time: { gt: 0 } } }),
                    webDb.tickets.count({ where: { status: "Waiting for admin response" } }),
                ]);
            ctx.htmlRaw(
                render("web-admin-dashboard", {
                    s: { totalUsers, activeUsers, totalAttacks, runningAttacks, waitingTickets },
                })
            );
        },
        { guard: "webAdmin" }
    );

    app.get(
        "/web/admin/users",
        async (ctx) => {
            const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
            let users = await webDb.users.findMany({ orderBy: { ID: "asc" } });
            if (q) users = users.filter((u) => String(u.username).toLowerCase().includes(q));
            ctx.htmlRaw(render("web-admin-users", { users, q }));
        },
        { guard: "webAdmin" }
    );

    app.get(
        "/web/admin/users/:id",
        async (ctx) => {
            const id = Number(ctx.params.id);
            const [user, plans] = await Promise.all([
                webDb.users.findUnique({ where: { ID: id } }),
                webDb.plans.findMany({ select: { ID: true, name: true } }),
            ]);
            if (!user) ctx.throw(404, "User not found");
            ctx.htmlRaw(render("web-admin-user-edit", { user, plans }));
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/users",
        async (ctx) => {
            const body = (await ctx.body()) as Body;
            const action = str(body, "action");
            const session = webSessions.load(ctx);
            if (action === "create") {
                const username = str(body, "username").trim();
                const password = str(body, "password");
                if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
                    throw new HttpError(
                        400,
                        "Username must be 3-20 letters, numbers, dots, dashes or underscores."
                    );
                }
                if (password.length < 10) {
                    throw new HttpError(400, "Password must be at least 10 characters.");
                }
                const rank = intValue(body, "rank", 0, 2, "Rank", 0);
                if (rank >= 2 && !(await actorIsSuper(ctx))) {
                    throw new HttpError(403, "Only a super admin can create another super admin.");
                }
                const membership = Number(body.membership ?? 0);
                await requirePlan(membership);
                const expire = intValue(body, "expire", 0, EXPIRY_MAX, "Expiry", 0);
                const created = await withLock("user:" + username.toLowerCase(), async () => {
                    if (usernameTaken(username))
                        throw new HttpError(409, "Username is already taken.");
                    return webDb.users.create({
                        data: {
                            username,
                            password: await bcrypt.hash(password, 12),
                            rank,
                            membership,
                            expire,
                            status: 0,
                            referral: "0",
                            referralbalance: 0,
                            testattack: 0,
                            activity: 0,
                            twoauth: 0,
                            referedBy: 0,
                            sessionVersion: 0,
                        },
                    });
                });
                await audit(ctx, "user.create", created.username);
                if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                    ctx.json({ success: "User created." });
                } else ctx.redirect("/web/admin/users", 303);
                return;
            }

            const id = Number(body.id);
            if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Missing user id.");
            if (action === "update") {
                const target = await webDb.users.findUnique({ where: { ID: id } });
                if (!target) throw new HttpError(404, "User not found.");
                const username = str(body, "username").trim();
                if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
                    throw new HttpError(
                        400,
                        "Username must be 3-20 letters, numbers, dots, dashes or underscores."
                    );
                }
                if (usernameTaken(username, id)) {
                    throw new HttpError(409, "Username is already taken.");
                }
                const rank = intValue(body, "rank", 0, 2, "Rank", Number(target.rank));
                if ((rank >= 2 || Number(target.rank) >= 2) && !(await actorIsSuper(ctx))) {
                    throw new HttpError(403, "Only a super admin can modify a super admin.");
                }
                if (Number(target.rank) >= 2 && rank < 2) {
                    const supers = await webDb.users.count({ where: { rank: 2 } });
                    if (supers <= 1)
                        throw new HttpError(400, "Cannot demote the last super admin.");
                }
                const membership = Number(body.membership ?? target.membership);
                await requirePlan(membership);
                const expire = intValue(
                    body,
                    "expire",
                    0,
                    EXPIRY_MAX,
                    "Expiry",
                    Number(target.expire)
                );
                const status =
                    body.status === undefined
                        ? Number(target.status) === 1
                            ? 1
                            : 0
                        : Number(body.status) === 1
                          ? 1
                          : 0;
                const pw = str(body, "password");
                let hashed = "";
                if (pw) {
                    if (pw.length < 10)
                        throw new HttpError(400, "Password must be at least 10 characters.");
                    hashed = await bcrypt.hash(pw, 12);
                }
                const oldUsername = String(target.username);
                await withLock("user:" + username.toLowerCase(), async () => {
                    webSqlite.transaction(() => {
                        const sets = [
                            "username = ?",
                            "rank = ?",
                            "status = ?",
                            "membership = ?",
                            "expire = ?",
                        ];
                        const values: Array<string | number> = [
                            username,
                            rank,
                            status,
                            membership,
                            expire,
                        ];
                        if (hashed) {
                            sets.push("password = ?", "sessionVersion = sessionVersion + 1");
                            values.push(hashed);
                        }
                        values.push(id);
                        webSqlite
                            .prepare(`update users set ${sets.join(", ")} where ID = ?`)
                            .run(...values);
                        if (oldUsername !== username) {
                            // Every username-keyed table follows the rename so a
                            // recycled name cannot inherit the old identity.
                            webSqlite
                                .prepare("update tickets set username = ? where username = ?")
                                .run(username, oldUsername);
                            webSqlite
                                .prepare("update messages set sender = ? where sender = ?")
                                .run(username, oldUsername);
                            webSqlite
                                .prepare("update logs set user = ? where user = ?")
                                .run(username, oldUsername);
                            webSqlite
                                .prepare("update actions set client = ? where client = ?")
                                .run(username, oldUsername);
                            webSqlite
                                .prepare("update loginlogs set username = ? where username = ?")
                                .run(username, oldUsername);
                        }
                    })();
                });
                await audit(ctx, "user.update", username);
                if (session?.userId === id) {
                    const fresh = await webDb.users.findUnique({ where: { ID: id } });
                    if (fresh) {
                        webSessions.save(ctx, {
                            userId: Number(fresh.ID),
                            username: fresh.username,
                            rank: Number(fresh.rank),
                            sv: Number(fresh.sessionVersion),
                        });
                    }
                }
                if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                    ctx.json({ success: "User updated." });
                } else ctx.redirect("/web/admin/users", 303);
            } else if (action === "delete") {
                if (session?.userId === id)
                    throw new HttpError(400, "You cannot delete your own account.");
                const target = await webDb.users.findUnique({ where: { ID: id } });
                if (!target) throw new HttpError(404, "User not found.");
                if (Number(target.rank) >= 2) {
                    if (!(await actorIsSuper(ctx))) {
                        throw new HttpError(403, "Only a super admin can delete a super admin.");
                    }
                    const supers = await webDb.users.count({ where: { rank: 2 } });
                    if (supers <= 1)
                        throw new HttpError(400, "Cannot delete the last super admin.");
                }
                const username = String(target.username);
                webSqlite.transaction(() => {
                    webSqlite
                        .prepare(
                            "delete from messages where ticketid in (select id from tickets where username = ?)"
                        )
                        .run(username);
                    webSqlite.prepare("delete from tickets where username = ?").run(username);
                    webSqlite
                        .prepare("update messages set sender = '[deleted]' where sender = ?")
                        .run(username);
                    webSqlite
                        .prepare("update logs set user = '[deleted]' where user = ?")
                        .run(username);
                    webSqlite
                        .prepare("update actions set client = '[deleted]' where client = ?")
                        .run(username);
                    webSqlite
                        .prepare("update loginlogs set username = '[deleted]' where username = ?")
                        .run(username);
                    webSqlite.prepare("delete from users where ID = ?").run(id);
                })();
                await audit(ctx, "user.delete", username);
                if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                    ctx.json({ success: "User deleted." });
                } else ctx.redirect("/web/admin/users", 303);
            } else throw new HttpError(400, "Unknown action.");
        },
        { guard: "webAdmin", limit: [30, 60_000] }
    );

    app.get(
        "/web/admin/plans",
        async (ctx) => {
            const plans = await webDb.plans.findMany({ orderBy: { price: "asc" } });
            ctx.htmlRaw(render("web-admin-plans", { plans }));
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/plans",
        async (ctx) => {
            const body = (await ctx.body()) as Body;
            const action = str(body, "action");
            if (action === "create") {
                const payload = planPayload(body);
                const created = await webDb.plans.create({ data: payload });
                await audit(ctx, "plan.create", String(created.ID));
            } else if (action === "update") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Missing plan id.");
                const payload = planPayload(body);
                const updated = await webDb.plans.update({ where: { ID: id }, data: payload });
                if (!updated) throw new HttpError(404, "Plan not found.");
                await audit(ctx, "plan.update", String(id));
            } else if (action === "delete") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Missing plan id.");
                const plan = await webDb.plans.findUnique({ where: { ID: id } });
                if (!plan) throw new HttpError(404, "Plan not found.");
                const [members, pending, cards] = await Promise.all([
                    webDb.users.count({ where: { membership: id } }),
                    webDb.payments.count({ where: { plan: id, paid: 0 } }),
                    webDb.giftcards.count({ where: { planID: id } }),
                ]);
                if (members > 0)
                    throw new HttpError(400, "Plan is assigned to users; reassign them first.");
                if (pending > 0)
                    throw new HttpError(400, "Plan has unpaid checkouts; resolve them first.");
                if (cards > 0)
                    throw new HttpError(
                        400,
                        "Plan is referenced by gift cards; remove them first."
                    );
                await webDb.plans.delete({ where: { ID: id } });
                await audit(ctx, "plan.delete", String(id));
            } else throw new HttpError(400, "Unknown action.");
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: "Saved." });
            } else ctx.redirect("/web/admin/plans", 303);
        },
        { guard: "webAdmin", limit: [30, 60_000] }
    );

    app.get(
        "/web/admin/methods",
        async (ctx) => {
            const methods = await webDb.methods.findMany({ orderBy: { type: "asc" } });
            ctx.htmlRaw(render("web-admin-methods", { methods }));
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/methods",
        async (ctx) => {
            const body = (await ctx.body()) as Body;
            const action = str(body, "action");
            const payload = methodPayload(body);
            const duplicateMethod = (exceptId = 0): boolean => {
                const row = webSqlite
                    .prepare("select id from methods where lower(name) = lower(?) limit 1")
                    .get(payload.name) as { id?: number } | undefined;
                return Boolean(row?.id && Number(row.id) !== exceptId);
            };
            if (action === "create") {
                if (duplicateMethod())
                    throw new HttpError(409, "A method with that name already exists.");
                await webDb.methods.create({ data: payload });
                await audit(ctx, "method.create", payload.name);
            } else if (action === "update") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing method id.");
                const existing = await webDb.methods.findUnique({ where: { id } });
                if (!existing) throw new HttpError(404, "Method not found.");
                if (duplicateMethod(id)) {
                    throw new HttpError(409, "A method with that name already exists.");
                }
                const oldName = String(existing.name);
                webSqlite.transaction(() => {
                    webSqlite
                        .prepare(
                            "update methods set name = ?, fullname = ?, type = ?, command = ? where id = ?"
                        )
                        .run(payload.name, payload.fullname, payload.type, payload.command, id);
                    if (oldName.toLowerCase() !== payload.name.toLowerCase()) {
                        const servers = webSqlite
                            .prepare("select id, methods from api")
                            .all() as Array<{ id: number; methods?: string }>;
                        const update = webSqlite.prepare("update api set methods = ? where id = ?");
                        for (const server of servers) {
                            const tokens = String(server.methods ?? "")
                                .split(",")
                                .map((token) => token.trim());
                            let changed = false;
                            const next = tokens.map((token) => {
                                if (token.toLowerCase() === oldName.toLowerCase()) {
                                    changed = true;
                                    return payload.name;
                                }
                                return token;
                            });
                            if (changed) update.run(next.join(","), server.id);
                        }
                    }
                })();
                await audit(ctx, "method.update", String(id));
            } else if (action === "delete") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing method id.");
                const method = await webDb.methods.findUnique({ where: { id } });
                if (!method) throw new HttpError(404, "Method not found.");
                const servers = await webDb.api.findMany({ select: { methods: true } });
                if (
                    servers.some((s) =>
                        String(s.methods)
                            .toUpperCase()
                            .split(",")
                            .map((m) => m.trim())
                            .includes(String(method.name).toUpperCase())
                    )
                ) {
                    throw new HttpError(
                        400,
                        "Method is used by an API server; remove it there first."
                    );
                }
                await webDb.methods.delete({ where: { id } });
                await audit(ctx, "method.delete", String(id));
            } else throw new HttpError(400, "Unknown action.");
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: "Saved." });
            } else ctx.redirect("/web/admin/methods", 303);
        },
        { guard: "webAdmin", limit: [30, 60_000] }
    );

    app.get(
        "/web/admin/news",
        async (ctx) => {
            const news = await webDb.news.findMany({ orderBy: { ID: "desc" } });
            ctx.htmlRaw(render("web-admin-news", { news }));
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/news",
        async (ctx) => {
            const body = (await ctx.body()) as Body;
            const action = str(body, "action");
            const payload = {
                title: str(body, "title").trim(),
                content: str(body, "content").trim(),
            };
            if (action === "create") {
                if (!payload.title || !payload.content)
                    throw new HttpError(400, "Title and content are required.");
                await webDb.news.create({
                    data: { ...payload, date: new Date().toISOString().slice(0, 10) },
                });
                await audit(ctx, "news.create", payload.title);
            } else if (action === "update") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing announcement id.");
                if (!payload.title || !payload.content)
                    throw new HttpError(400, "Title and content are required.");
                await webDb.news.update({ where: { ID: id }, data: payload });
                await audit(ctx, "news.update", String(id));
            } else if (action === "delete") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing announcement id.");
                await webDb.news.delete({ where: { ID: id } });
                await audit(ctx, "news.delete", String(id));
            } else throw new HttpError(400, "Unknown action.");
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: "Saved." });
            } else ctx.redirect("/web/admin/news", 303);
        },
        { guard: "webAdmin", limit: [30, 60_000] }
    );

    app.get(
        "/web/admin/servers",
        async (ctx) => {
            const servers = await webDb.api.findMany({ orderBy: { name: "asc" } });
            ctx.htmlRaw(render("web-admin-servers", { servers }));
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/servers",
        async (ctx) => {
            const body = (await ctx.body()) as Body;
            const action = str(body, "action");
            const payload = await serverPayload(body);
            const duplicateName = async (exceptId = 0): Promise<boolean> => {
                const row = webSqlite
                    .prepare("select id from api where lower(name) = lower(?) limit 1")
                    .get(payload.name) as { id?: number } | undefined;
                return Boolean(row?.id && Number(row.id) !== exceptId);
            };
            if (action === "create") {
                if (await duplicateName())
                    throw new HttpError(409, "A server with that name already exists.");
                await webDb.api.create({ data: payload });
                await audit(ctx, "server.create", payload.name);
            } else if (action === "update") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing server id.");
                const existing = await webDb.api.findUnique({ where: { id } });
                if (!existing) throw new HttpError(404, "Server not found.");
                if (await duplicateName(id))
                    throw new HttpError(409, "A server with that name already exists.");
                if (String(existing.name) !== payload.name) {
                    expireFinishedAttacks();
                    const running = await webDb.logs.count({
                        where: { handler: existing.name, stopped: 0, time: { gt: 0 } },
                    });
                    if (running > 0) {
                        throw new HttpError(
                            400,
                            "Server is handling running attacks; wait for them to finish."
                        );
                    }
                }
                const updated = await webDb.api.update({ where: { id }, data: payload });
                if (!updated) throw new HttpError(404, "Server not found.");
                await audit(ctx, "server.update", String(id));
            } else if (action === "delete") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing server id.");
                const server = await webDb.api.findUnique({ where: { id } });
                if (!server) throw new HttpError(404, "Server not found.");
                expireFinishedAttacks();
                const running = await webDb.logs.count({
                    where: { handler: server.name, stopped: 0, time: { gt: 0 } },
                });
                if (running > 0) {
                    throw new HttpError(
                        400,
                        "Server is handling running attacks; wait for them to finish."
                    );
                }
                await webDb.api.delete({ where: { id } });
                await audit(ctx, "server.delete", String(id));
            } else throw new HttpError(400, "Unknown action.");
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: "Saved." });
            } else ctx.redirect("/web/admin/servers", 303);
        },
        { guard: "webAdmin", limit: [30, 60_000] }
    );

    app.get(
        "/web/admin/giftcards",
        async (ctx) => {
            const [cards, plans] = await Promise.all([
                webDb.giftcards.findMany({ orderBy: { ID: "desc" } }),
                webDb.plans.findMany({ select: { ID: true, name: true } }),
            ]);
            ctx.htmlRaw(render("web-admin-giftcards", { cards, plans }));
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/giftcards",
        async (ctx) => {
            const body = (await ctx.body()) as Body;
            const action = str(body, "action");
            if (action === "generate") {
                const planID = Number(body.planID);
                if (!Number.isInteger(planID) || planID <= 0)
                    throw new HttpError(400, "Choose a plan.");
                const plan = await webDb.plans.findUnique({ where: { ID: planID } });
                if (!plan) throw new HttpError(400, "That plan does not exist.");
                const termSeconds = planTerm(plan);
                const count = Math.min(Math.max(Number(body.count) || 1, 1), 100);
                const now = Math.floor(Date.now() / 1000);
                await withLock("giftcards", async () => {
                    for (let i = 0; i < count; i += 1) {
                        let code = "";
                        for (let attempt = 0; attempt < 5; attempt += 1) {
                            code = `GC-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
                            const exists = await webDb.giftcards.findFirst({ where: { code } });
                            if (!exists) break;
                            code = "";
                        }
                        if (!code)
                            throw new HttpError(500, "Could not generate a unique gift card code.");
                        await webDb.giftcards.create({
                            data: {
                                code,
                                planID,
                                claimedby: 0,
                                dateClaimed: 0,
                                date: now,
                                termSeconds,
                            },
                        });
                    }
                });
                await audit(ctx, "giftcard.generate", String(count));
            } else if (action === "update") {
                const id = Number(body.id);
                const planID = Number(body.planID);
                if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(planID) || planID <= 0)
                    throw new HttpError(400, "Gift card and plan are required.");
                const card = await webDb.giftcards.findUnique({ where: { ID: id } });
                if (!card) throw new HttpError(404, "Gift card not found.");
                if (Number(card.claimedby) !== 0)
                    throw new HttpError(400, "Claimed gift cards cannot be edited.");
                const plan = await webDb.plans.findUnique({ where: { ID: planID } });
                if (!plan) throw new HttpError(400, "That plan does not exist.");
                await webDb.giftcards.update({
                    where: { ID: id },
                    data: { planID, termSeconds: planTerm(plan) },
                });
                await audit(ctx, "giftcard.update", String(id));
            } else if (action === "revoke") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing gift card id.");
                const card = await webDb.giftcards.findUnique({ where: { ID: id } });
                if (!card) throw new HttpError(404, "Gift card not found.");
                if (Number(card.claimedby) !== 0)
                    throw new HttpError(400, "Only unclaimed gift cards can be revoked.");
                await webDb.giftcards.update({
                    where: { ID: id },
                    data: { claimedby: -1 },
                });
                await audit(ctx, "giftcard.revoke", String(id));
            } else if (action === "delete") {
                const id = Number(body.id);
                if (!Number.isInteger(id) || id <= 0)
                    throw new HttpError(400, "Missing gift card id.");
                const card = await webDb.giftcards.findUnique({ where: { ID: id } });
                if (!card) throw new HttpError(404, "Gift card not found.");
                // A claimed card granted real plan time; deleting it without a
                // recorded reversal would erase the audit trail.
                if (Number(card.claimedby) > 0)
                    throw new HttpError(400, "Claimed gift cards cannot be deleted.");
                await webDb.giftcards.delete({ where: { ID: id } });
                await audit(ctx, "giftcard.delete", String(id));
            } else throw new HttpError(400, "Unknown action.");
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: "Saved." });
            } else ctx.redirect("/web/admin/giftcards", 303);
        },
        { guard: "webAdmin", limit: [30, 60_000] }
    );

    app.get(
        "/web/admin/tickets",
        async (ctx) => {
            const status = ctx.query.get("status");
            const where =
                status === "open"
                    ? { status: "Waiting for admin response" }
                    : status === "user"
                      ? { status: "Waiting for user response" }
                      : status === "closed"
                        ? { status: "Closed" }
                        : undefined;
            const tickets = await webDb.tickets.findMany({
                where,
                orderBy: { date: "desc" },
            });
            ctx.htmlRaw(render("web-admin-tickets", { tickets, status: status ?? "all" }));
        },
        { guard: "webAdmin" }
    );

    app.get(
        "/web/admin/tickets/:id",
        async (ctx) => {
            const id = Number(ctx.params.id);
            const ticket = await webDb.tickets.findUnique({ where: { id } });
            if (!ticket) ctx.throw(404, "Ticket not found");
            const messages = await webDb.messages.findMany({
                where: { ticketid: id },
                orderBy: { date: "asc" },
            });
            ctx.htmlRaw(render("web-admin-ticket", { ticket, messages }));
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/tickets",
        async (ctx) => {
            const body = (await ctx.body()) as Body;
            const id = Number(body.id);
            const action = str(body, "action");
            const ticket = await webDb.tickets.findUnique({ where: { id } });
            if (!ticket) throw new HttpError(404, "Ticket not found.");
            if (action === "reply") {
                if (ticket.status === "Closed") {
                    throw new HttpError(400, "Reopen the ticket before replying.");
                }
                const content = str(body, "content").trim();
                if (!content) throw new HttpError(400, "Reply content is required.");
                await webDb.messages.create({
                    data: {
                        ticketid: id,
                        content,
                        sender: actor(ctx),
                        date: Math.floor(Date.now() / 1000),
                    },
                });
                await webDb.tickets.update({
                    where: { id },
                    data: { status: "Waiting for user response" },
                });
                await audit(ctx, "ticket.reply", String(id));
            } else if (action === "close") {
                await webDb.tickets.update({ where: { id }, data: { status: "Closed" } });
                await audit(ctx, "ticket.close", String(id));
            } else if (action === "reopen") {
                await webDb.tickets.update({
                    where: { id },
                    data: { status: "Waiting for admin response" },
                });
                await audit(ctx, "ticket.reopen", String(id));
            } else if (action === "delete") {
                await webDb.messages.deleteMany({ where: { ticketid: id } });
                await webDb.tickets.delete({ where: { id } });
                await audit(ctx, "ticket.delete", String(id));
                ctx.redirect("/web/admin/tickets", 303);
                return;
            } else throw new HttpError(400, "Unknown action.");
            ctx.redirect("/web/admin/tickets/" + id, 303);
        },
        { guard: "webAdmin", limit: [60, 60_000] }
    );

    app.get(
        "/web/admin/attacklogs",
        async (ctx) => {
            expireFinishedAttacks();
            const logs = await webDb.logs.findMany({ orderBy: { date: "desc" }, take: 200 });
            ctx.htmlRaw(render("web-admin-attacklogs", { logs }));
        },
        { guard: "webAdmin" }
    );

    app.get(
        "/web/admin/loginlogs",
        async (ctx) => {
            const logs = await webDb.loginlogs.findMany({ orderBy: { date: "desc" }, take: 200 });
            ctx.htmlRaw(render("web-admin-loginlogs", { logs }));
        },
        { guard: "webAdmin" }
    );

    app.get(
        "/web/admin/hub",
        async (ctx) => {
            const methods = await webDb.methods.findMany({ orderBy: { name: "asc" } });
            const typed = methods as Array<{ name: string; fullname: string; type: string }>;
            ctx.htmlRaw(
                render("web-admin-hub", {
                    layer4: typed.filter((m) => m.type === "layer4"),
                    layer7: typed.filter((m) => m.type === "layer7"),
                    servers: await webDb.api.findMany({ select: { name: true, slots: true } }),
                    error: ctx.query.get("error") ?? "",
                    launched: ctx.query.get("launched") === "1",
                })
            );
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/hub",
        async (ctx) => {
            if (!features.ipstress) {
                if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                    ctx.json({ error: "This feature is disabled." }, 403);
                } else ctx.redirect("/web/admin/hub?error=disabled", 303);
                return;
            }
            const f = await ctx.form();
            if (!f.host || !f.time || !f.method) {
                throw new HttpError(400, "Host, time, and method are required.");
            }
            try {
                const result = await launchAttack({
                    username: actor(ctx),
                    input: {
                        host: f.host,
                        port: f.port || "80",
                        time: f.time,
                        method: f.method,
                        serverName: f.server,
                    },
                    admin: true,
                    origin: "admin",
                });
                await audit(ctx, "hub.launch", result.host);
                if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                    ctx.json({
                        success: `Attack launched on ${result.host}:${result.port} for ${result.seconds}s using ${result.method}.`,
                    });
                } else {
                    ctx.redirect("/web/admin/hub?launched=1", 303);
                }
            } catch (error) {
                if (error instanceof HttpError && error.status < 500) {
                    if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                        ctx.json({ error: error.message }, error.status);
                    } else {
                        ctx.redirect(
                            "/web/admin/hub?error=" + encodeURIComponent(error.message),
                            303
                        );
                    }
                    return;
                }
                throw error;
            }
        },
        { guard: "webAdmin", limit: [20, 60_000] }
    );

    app.get(
        "/web/admin/settings",
        async (ctx) => {
            const s = await webDb.settings.findFirst();
            ctx.htmlRaw(
                render("web-admin-settings", {
                    s: {
                        sitename: s?.sitename ?? "IPstress",
                        url: s?.url ?? "",
                        description: s?.description ?? "",
                        cooldown: s?.cooldown ?? 60,
                        cooldownTime: s?.cooldownTime ?? 300,
                        maxattacks: s?.maxattacks ?? 5,
                        maintaince: String(s?.maintaince ?? "0"),
                        stripePubKey: s?.stripePubKey ?? "",
                        hasStripeSecret: Boolean(s?.stripeSecretKey),
                    },
                })
            );
        },
        { guard: "webAdmin" }
    );

    app.post(
        "/web/api/admin/settings",
        async (ctx) => {
            const body = (await ctx.body()) as Record<string, string>;
            const existing = await webDb.settings.findFirst();
            if (!existing) throw new HttpError(404, "Settings row not found.");
            const general = [
                "sitename",
                "url",
                "description",
                "cooldown",
                "cooldownTime",
                "maxattacks",
                "maintaince",
                "stripePubKey",
            ] as const;
            const secrets = ["stripeSecretKey"] as const;
            const update: Record<string, string | number> = {};
            for (const key of general) {
                if (body[key] !== undefined) update[key] = body[key];
            }
            for (const key of secrets) {
                const value = str(body, key).trim();
                if (value) update[key] = sealSecret(value);
                if (body["clear_" + key] === "on") update[key] = "";
            }
            if (Object.keys(update).length > 0) {
                await webDb.settings.update({
                    where: { sitename: existing.sitename },
                    data: update,
                });
                invalidateWebSettings();
                await audit(ctx, "settings.update", Object.keys(update).join(","));
            }
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: "Settings saved." });
            } else ctx.redirect("/web/admin/settings", 303);
        },
        { guard: "webAdmin" }
    );
}
