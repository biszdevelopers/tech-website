/**
 * WEB ADMIN ROUTES - every /web/admin/* page + CRUD API.
 * All routes carry the webAdmin guard. Data mutations follow the legacy
 * action=create/update/delete protocol via hidden form fields.
 */

import { Application } from "../core/01-application";
import { HttpError } from "../core/09-errors";
import { webDb, expireFinishedAttacks } from "../lib/db/web";
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

function money(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
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
function num(body: Body, key: string, fallback = 0): number {
    return Number(body[key] ?? fallback) || fallback;
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
                if (username.length < 3 || username.length > 20) {
                    throw new HttpError(400, "Username must be 3-20 characters.");
                }
                if (password.length < 10) {
                    throw new HttpError(400, "Password must be at least 10 characters.");
                }
                const rank = Math.min(Math.max(num(body, "rank"), 0), 2);
                if (rank >= 2 && !(await actorIsSuper(ctx))) {
                    throw new HttpError(403, "Only a super admin can create another super admin.");
                }
                const created = await withLock("user:" + username.toLowerCase(), async () => {
                    const exists = await webDb.users.findFirst({ where: { username } });
                    if (exists) throw new HttpError(409, "Username is already taken.");
                    return webDb.users.create({
                        data: {
                            username,
                            password: await bcrypt.hash(password, 12),
                            rank,
                            membership: num(body, "membership"),
                            expire: num(body, "expire"),
                            status: 0,
                            referral: "0",
                            referralbalance: 0,
                            testattack: 0,
                            activity: 0,
                            twoauth: 0,
                            referedBy: 0,
                        },
                    });
                });
                await audit(ctx, "user.create", created.username);
                if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                    ctx.json({ success: "User created." });
                } else ctx.redirect("/web/admin/users", 303);
                return;
            }

            const id = num(body, "id");
            if (!id) throw new HttpError(400, "Missing user id.");
            if (action === "update") {
                const target = await webDb.users.findUnique({ where: { ID: id } });
                if (!target) throw new HttpError(404, "User not found.");
                const username = str(body, "username").trim();
                if (username.length < 3 || username.length > 20) {
                    throw new HttpError(400, "Username must be 3-20 characters.");
                }
                const duplicate = await webDb.users.findFirst({ where: { username } });
                if (duplicate && duplicate.ID !== id) {
                    throw new HttpError(409, "Username is already taken.");
                }
                const rank = Math.min(Math.max(num(body, "rank"), 0), 2);
                if ((rank >= 2 || Number(target.rank) >= 2) && !(await actorIsSuper(ctx))) {
                    throw new HttpError(403, "Only a super admin can modify a super admin.");
                }
                if (Number(target.rank) >= 2 && rank < 2) {
                    const supers = await webDb.users.count({ where: { rank: 2 } });
                    if (supers <= 1)
                        throw new HttpError(400, "Cannot demote the last super admin.");
                }
                const data: Record<string, string | number> = {
                    username,
                    rank,
                    status: num(body, "status") === 1 ? 1 : 0,
                    membership: num(body, "membership"),
                    expire: num(body, "expire"),
                };
                const pw = str(body, "password");
                if (pw) {
                    if (pw.length < 10)
                        throw new HttpError(400, "Password must be at least 10 characters.");
                    data.password = await bcrypt.hash(pw, 12);
                }
                await webDb.users.update({ where: { ID: id }, data });
                await audit(ctx, "user.update", username);
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
                await webDb.users.delete({ where: { ID: id } });
                await audit(ctx, "user.delete", target.username);
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
            const payload = {
                name: str(body, "name").trim(),
                price: money(body.price),
                length: num(body, "length"),
                mbt: num(body, "mbt"),
                concurrents: num(body, "concurrents"),
                vip: num(body, "vip") ? 1 : 0,
                unit: str(body, "unit", "days") || "days",
                private: num(body, "private") ? 1 : 0,
            };
            if (action === "create") {
                if (!payload.name) throw new HttpError(400, "Plan name is required.");
                const created = await webDb.plans.create({ data: payload });
                await audit(ctx, "plan.create", String(created.ID));
            } else if (action === "update") {
                const id = num(body, "id");
                if (!id) throw new HttpError(400, "Missing plan id.");
                if (!payload.name) throw new HttpError(400, "Plan name is required.");
                await webDb.plans.update({ where: { ID: id }, data: payload });
                await audit(ctx, "plan.update", String(id));
            } else if (action === "delete") {
                const id = num(body, "id");
                const inUse = await webDb.users.count({ where: { membership: id } });
                if (inUse > 0)
                    throw new HttpError(400, "Plan is assigned to users; reassign them first.");
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
            const payload = {
                name: str(body, "name").trim(),
                fullname: str(body, "fullname").trim(),
                type: str(body, "type") === "layer7" ? "layer7" : "layer4",
                command: str(body, "command").trim(),
            };
            if (action === "create") {
                if (!payload.name || !payload.fullname)
                    throw new HttpError(400, "Name and full name are required.");
                await webDb.methods.create({ data: payload });
                await audit(ctx, "method.create", payload.name);
            } else if (action === "update") {
                const id = num(body, "id");
                if (!id) throw new HttpError(400, "Missing method id.");
                if (!payload.name || !payload.fullname)
                    throw new HttpError(400, "Name and full name are required.");
                await webDb.methods.update({ where: { id }, data: payload });
                await audit(ctx, "method.update", String(id));
            } else if (action === "delete") {
                const id = num(body, "id");
                const servers = await webDb.api.findMany({ select: { methods: true, name: true } });
                const method = await webDb.methods.findUnique({ where: { id } });
                if (
                    method &&
                    servers.some((s) =>
                        String(s.methods)
                            .toUpperCase()
                            .split(",")
                            .map((m) => m.trim())
                            .includes(method.name.toUpperCase())
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
                const id = num(body, "id");
                if (!id) throw new HttpError(400, "Missing announcement id.");
                if (!payload.title || !payload.content)
                    throw new HttpError(400, "Title and content are required.");
                await webDb.news.update({ where: { ID: id }, data: payload });
                await audit(ctx, "news.update", String(id));
            } else if (action === "delete") {
                await webDb.news.delete({ where: { ID: num(body, "id") } });
                await audit(ctx, "news.delete", String(body.id));
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
            const apiUrl = str(body, "api").trim();
            if (apiUrl && !/^https?:\/\//i.test(apiUrl)) {
                throw new HttpError(400, "API URL must start with http:// or https://.");
            }
            if (apiUrl) {
                try {
                    new URL(apiUrl);
                } catch {
                    throw new HttpError(400, "API URL is invalid.");
                }
            }
            const payload = {
                name: str(body, "name").trim(),
                api: apiUrl,
                slots: num(body, "slots", 10),
                methods: str(body, "methods", "").trim(),
                vip: num(body, "vip") ? 1 : 0,
            };
            if (action === "create") {
                if (!payload.name) throw new HttpError(400, "Server name is required.");
                await webDb.api.create({ data: payload });
                await audit(ctx, "server.create", payload.name);
            } else if (action === "update") {
                const id = num(body, "id");
                if (!id) throw new HttpError(400, "Missing server id.");
                if (!payload.name) throw new HttpError(400, "Server name is required.");
                await webDb.api.update({ where: { id }, data: payload });
                await audit(ctx, "server.update", String(id));
            } else if (action === "delete") {
                const id = num(body, "id");
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
                const planID = num(body, "planID");
                if (!planID) throw new HttpError(400, "Choose a plan.");
                const count = Math.min(Math.max(num(body, "count", 1), 1), 100);
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
                            data: { code, planID, claimedby: 0, dateClaimed: 0, date: now },
                        });
                    }
                });
                await audit(ctx, "giftcard.generate", String(count));
            } else if (action === "update") {
                const id = num(body, "id");
                const planID = num(body, "planID");
                if (!id || !planID) throw new HttpError(400, "Gift card and plan are required.");
                await webDb.giftcards.update({ where: { ID: id }, data: { planID } });
                await audit(ctx, "giftcard.update", String(id));
            } else if (action === "revoke") {
                await webDb.giftcards.update({
                    where: { ID: num(body, "id") },
                    data: { claimedby: -1 },
                });
                await audit(ctx, "giftcard.revoke", String(body.id));
            } else if (action === "delete") {
                await webDb.giftcards.delete({ where: { ID: num(body, "id") } });
                await audit(ctx, "giftcard.delete", String(body.id));
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
            const id = num(body, "id");
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
                        hasPaypal: Boolean(s?.paypal),
                        hasBitcoin: Boolean(s?.bitcoin),
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
            const secrets = ["paypal", "bitcoin", "stripeSecretKey"] as const;
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
