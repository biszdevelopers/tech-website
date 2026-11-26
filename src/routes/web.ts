/**
 * ============================================================================
 * WEB ROUTES - SaaS auth APIs, hub, profile, tickets, giftcards, affiliate,
 * wheel. Pages render via the web-*.ejs templates; every handler below keeps
 * the same guards, limits and response shapes as the audited Next.js routes.
 * ============================================================================
 */

import { Application } from "../core/01-application";
import { Context } from "../core/03-context";
import { HttpError } from "../core/09-errors";
import { webSessions, requireWebUser, optionalWebUser } from "./guards";
import { features } from "../config/features";
import { env } from "../config/env";
import { rateLimit } from "../lib/rate-limit";
import { webDb, webSqlite, expireFinishedAttacks } from "../lib/db/web";
import { webLoginSchema, webRegisterSchema } from "../lib/validations/web-auth";
import { render } from "../core/views";
import { randomInt } from "node:crypto";
import { withLock } from "../lib/lock";
import { launchAttack } from "../server/attacks";
import { verifyPassword } from "../lib/passwords";
import { isWebMaintenance } from "../lib/web-settings";
import type { PlanRow, UserRow } from "../types/db";
import bcrypt from "bcryptjs";
import { buildPageMeta } from "../lib/seo";

function privateMeta(title: string, path: string) {
    return buildPageMeta({ title, description: "IPstress account area.", path, robots: "private" });
}

type Body = Record<string, unknown>;

function safeNext(value: unknown): string {
    const next = String(value ?? "");
    if (!next.startsWith("/web/") || next.startsWith("//") || next.includes("\\"))
        return "/web/dashboard";
    if (next.startsWith("/web/login") || next.startsWith("/web/api/")) return "/web/dashboard";
    return next;
}

/** Constant hash so unknown usernames cost the same as wrong passwords. */
const DUMMY_HASH = "$2b$12$.5XkKkyMWCtIYiGjUqvHeuWjs5kNjl7nOYChlviJiHgVUgE4A.h6C";

/** Whole seconds a plan grants. Shared by checkout, webhook and gift cards. */
export function planTermSeconds(plan: { length: number; unit: string }): number {
    return Math.max(Number(plan.length) || 0, 1) * (plan.unit === "hours" ? 3600 : 86400);
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/** A membership row only counts while it is set and not past its expiry. */
function hasActiveMembership(user: { membership: number; expire: number }): boolean {
    return Number(user.membership) > 0 && Number(user.expire) > nowSeconds();
}

/** Usernames are unique case-insensitively; SQLite's UNIQUE is not. */
export function findUserByName(username: string): UserRow | undefined {
    return webSqlite
        .prepare("select * from users where lower(username) = lower(?) limit 1")
        .get(username) as UserRow | undefined;
}

/** Shared guard: valid session + existing user row; returns the user. */
async function currentUser(ctx: Context) {
    const session = await requireWebUser(ctx);
    const user = await webDb.users.findUnique({ where: { ID: session.userId! } });
    if (!user) ctx.throw(404, "User not found");
    if (Number(user.status) === 1) ctx.throw(403, "Your account has been banned.");
    return user as UserRow;
}

function wantsJson(ctx: Context): boolean {
    return String(ctx.raw.headers.accept ?? "").includes("application/json");
}

export function registerWebRoutes(app: Application): void {
    // ----------------------------------------------------------------- gates
    // Runs before every route, including the page routes wired in server.ts.
    // Feature switches turn the matching page into a 404 and its API into a
    // 403, so disabling a feature cannot leave a reachable surface behind.
    app.use(async (ctx, next) => {
        if (!ctx.path.startsWith("/web")) {
            await next();
            return;
        }
        const path = ctx.path;

        const featureOff =
            (!features.payments && path === "/web/plan") ||
            (!features.wheel && (path === "/web/wheel" || path.startsWith("/web/api/wheel"))) ||
            (!features.affiliate && (path === "/web/affiliate" || path === "/web/api/affiliate")) ||
            (!features.giftcards &&
                (path === "/web/giftcards" || path.startsWith("/web/api/giftcards"))) ||
            (!features.ipstress && (path === "/web/hub" || path.startsWith("/web/api/hub")));
        if (featureOff) {
            if (path.startsWith("/web/api/")) ctx.json({ error: "This feature is disabled." }, 403);
            else ctx.throw(404, "Page not found.");
            return;
        }

        // Maintenance blocks everything except recoverable entry points:
        // login/logout, the maintenance page itself, admin, Stripe webhook and
        // images. Registration is intentionally NOT exempt.
        const exempt =
            path === "/web/maintenance" ||
            path === "/web/login" ||
            path === "/web/api/auth/login" ||
            path === "/web/api/auth/logout" ||
            path.startsWith("/web/admin") ||
            path.startsWith("/web/api/admin/") ||
            path.startsWith("/web/images/") ||
            path === "/web/api/payments/stripe/webhook";
        if (!exempt) {
            if (await isWebMaintenance()) {
                if (path.startsWith("/web/api/")) {
                    ctx.json({ error: "Maintenance mode." }, 503);
                } else {
                    ctx.redirect("/web/maintenance", 303);
                }
                return;
            }
        }

        // Pages wired in server.ts read the raw session; refreshing it here
        // enforces the ban and sessionVersion checks before they render.
        if (
            ctx.method === "GET" &&
            (path === "/web/plan" ||
                path === "/web/giftcards" ||
                path === "/web/affiliate" ||
                path === "/web/wheel" ||
                path === "/web/tickets/new")
        ) {
            const user = await optionalWebUser(ctx);
            if (!user && (path === "/web/wheel" || path === "/web/tickets/new")) {
                ctx.redirect("/web/login", 303);
                return;
            }
        }
        await next();
    });

    // ------------------------------------------------------------------ auth
    app.post("/web/api/auth/login", async (ctx) => {
        const asHtml = !wantsJson(ctx);
        if (!rateLimit("web-login:" + ctx.ip, 10, 60_000)) {
            if (asHtml) {
                ctx.redirect("/web/login?error=rate", 303);
                return;
            }
            throw new HttpError(429, "Too many login attempts. Try again in a minute.");
        }
        const form = await ctx.body(webLoginSchema);
        const next = safeNext((form as Body).next);
        if (!rateLimit("web-login-user:" + form.username.toLowerCase(), 10, 60_000)) {
            if (asHtml) {
                ctx.redirect("/web/login?error=rate&next=" + encodeURIComponent(next), 303);
                return;
            }
            throw new HttpError(429, "Too many login attempts. Try again in a minute.");
        }
        const user = findUserByName(form.username);
        const check = await verifyPassword(form.password, user?.password ?? DUMMY_HASH);
        if (!user || !check.ok) {
            if (asHtml) {
                ctx.redirect("/web/login?error=invalid&next=" + encodeURIComponent(next), 303);
                return;
            }
            throw new HttpError(401, "Invalid username or password.");
        }
        if (check.rehashed) {
            await webDb.users.update({
                where: { ID: user.ID },
                data: { password: check.rehashed },
            });
        }
        if (Number(user.status) === 1) {
            if (asHtml) {
                ctx.redirect("/web/login?error=banned&next=" + encodeURIComponent(next), 303);
                return;
            }
            throw new HttpError(403, "Your account has been banned.");
        }
        await webSessions.save(ctx, {
            userId: user.ID,
            username: user.username,
            rank: Number(user.rank),
            sv: Number(user.sessionVersion),
        });
        await webDb.loginlogs
            .create({
                data: {
                    username: user.username,
                    ip: ctx.ip,
                    date: nowSeconds(),
                    country: "",
                },
            })
            .catch(() => undefined);
        ctx.redirect(next, 303);
    });

    app.post("/web/api/auth/logout", async (ctx) => {
        webSessions.destroy(ctx);
        ctx.redirect("/web/login", 303);
    });

    app.post("/web/api/auth/register", async (ctx) => {
        const asHtml = !wantsJson(ctx);
        const fail = (status: number, message: string): void => {
            if (asHtml) {
                ctx.redirect("/web/register?error=" + encodeURIComponent(message), 303);
                return;
            }
            throw new HttpError(status, message);
        };
        if (!rateLimit("register:" + ctx.ip, 5, 3_600_000)) {
            fail(429, "Too many registration attempts. Try again later.");
            return;
        }
        const form = await ctx.body();
        const parsed = webRegisterSchema.safeParse(form);
        if (!parsed.success) {
            fail(400, parsed.error.issues[0]?.message ?? "Validation failed");
            return;
        }

        const referrerId = Number((form as Body).ref ?? 0);
        const referrer =
            Number.isFinite(referrerId) && referrerId > 0
                ? await webDb.users.findUnique({ where: { ID: referrerId }, select: { ID: true } })
                : null;

        const hashedPassword = await bcrypt.hash(parsed.data.password, 12);
        const username = parsed.data.username;
        try {
            const newUser = await withLock("user:" + username.toLowerCase(), async () => {
                if (findUserByName(username)) throw new HttpError(409, "Username is already taken");
                return webDb.users.create({
                    data: {
                        username,
                        password: hashedPassword,
                        rank: 0,
                        membership: 0,
                        expire: 0,
                        status: 0,
                        referral: "0",
                        referralbalance: 0,
                        testattack: 0,
                        activity: 0,
                        twoauth: 0,
                        referedBy: referrer && referrer.ID !== 0 ? referrer.ID : 0,
                        sessionVersion: 0,
                    },
                });
            });
            await webSessions.save(ctx, {
                userId: newUser.ID,
                username: newUser.username,
                rank: Number(newUser.rank),
                sv: Number(newUser.sessionVersion ?? 0),
            });
            if (wantsJson(ctx)) {
                ctx.json({ success: "You have successfully registered! Redirecting..." });
            } else {
                ctx.redirect("/web/dashboard", 303);
            }
        } catch (error) {
            if (error instanceof HttpError && error.status < 500) {
                fail(error.status, error.message);
                return;
            }
            throw error;
        }
    });

    // ------------------------------------------------------------- dashboard
    app.get(
        "/web/dashboard",
        async (ctx) => {
            const user = await currentUser(ctx);
            expireFinishedAttacks();
            const plan = hasActiveMembership(user)
                ? ((await webDb.plans.findUnique({
                      where: { ID: user.membership },
                  })) as PlanRow | null)
                : null;
            const runningAttacks = await webDb.logs.count({
                where: { user: user.username, stopped: 0, time: { gt: 0 } },
            });
            const totalAttacks = await webDb.logs.count({ where: { user: user.username } });
            const purchased = ctx.query.get("purchased") === "1";
            const [paidPayments, pendingPayments] = purchased
                ? await Promise.all([
                      webDb.payments.count({ where: { user: user.ID, paid: { gt: 0 } } }),
                      webDb.payments.count({ where: { user: user.ID, paid: 0 } }),
                  ])
                : [1, 0];
            ctx.htmlRaw(
                render("web-dashboard", {
                    meta: privateMeta("Dashboard | IPstress", "/web/dashboard"),
                    signedIn: true,
                    purchased,
                    processing: purchased && (paidPayments === 0 || pendingPayments > 0),
                    planName: plan ? plan.name : "No active plan",
                    maxTime: plan ? `${plan.mbt}s` : "No active plan",
                    maxConcurrents: plan ? String(plan.concurrents) : "No active plan",
                    expiry: plan
                        ? new Date(Number(user.expire) * 1000).toLocaleDateString("en-US")
                        : "No active plan",
                    runningAttacks,
                    totalAttacks,
                    flags: features,
                })
            );
        },
        { guard: "webUser" }
    );

    // ------------------------------------------------------------------ hub
    app.get(
        "/web/hub",
        async (ctx) => {
            const user = await currentUser(ctx);
            const plan = hasActiveMembership(user)
                ? ((await webDb.plans.findUnique({
                      where: { ID: user.membership },
                  })) as PlanRow | null)
                : null;
            const [methods, allServers] = await Promise.all([
                webDb.methods.findMany({
                    select: { id: true, name: true, fullname: true },
                    orderBy: { name: "asc" },
                }),
                webDb.api.findMany({
                    select: { id: true, name: true, slots: true, methods: true, vip: true },
                    orderBy: { name: "asc" },
                }),
            ]);
            const vipPlan = plan ? Number(plan.vip) === 1 : false;
            const servers = plan
                ? allServers.filter(
                      (s) =>
                          (vipPlan || Number(s.vip) !== 1) && String(s.methods ?? "").trim() !== ""
                  )
                : [];
            ctx.htmlRaw(
                render("web-hub", {
                    meta: privateMeta("Hub | IPstress", "/web/hub"),
                    signedIn: true,
                    methods: methods as never[],
                    servers: servers as never[],
                    maxTime: plan ? Number(plan.mbt) : 0,
                    planName: plan ? plan.name : "",
                    error: ctx.query.get("error") ?? "",
                    launched: ctx.query.get("launched") === "1",
                })
            );
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/hub",
        async (ctx) => {
            const acceptJson = wantsJson(ctx);
            const back = (error?: string): void => {
                ctx.redirect(
                    "/web/hub?" + (error ? "error=" + encodeURIComponent(error) : "launched=1"),
                    303
                );
            };
            const fail = (status: number, message: string): void => {
                if (acceptJson) ctx.json({ error: message }, status);
                else back(message);
            };
            if (!features.ipstress) {
                fail(403, "This feature is disabled.");
                return;
            }
            if (!rateLimit("hub:" + ctx.ip, 20, 60_000)) {
                fail(429, "Rate limit exceeded.");
                return;
            }
            const user = await currentUser(ctx);
            if (!hasActiveMembership(user)) {
                fail(403, "You need an active membership to launch attacks.");
                return;
            }
            const plan = (await webDb.plans.findUnique({
                where: { ID: user.membership },
            })) as PlanRow | null;
            if (!plan) {
                fail(403, "Your plan is no longer available.");
                return;
            }

            const form = await ctx.form();
            if (!form.host || !form.time || !form.method) {
                fail(400, "Host, time, and method are required.");
                return;
            }
            try {
                const result = await launchAttack({
                    username: user.username,
                    plan: {
                        mbt: Number(plan.mbt),
                        concurrents: Number(plan.concurrents),
                        vip: Number(plan.vip) === 1,
                    },
                    input: {
                        host: form.host,
                        port: form.port || "80",
                        time: form.time,
                        method: form.method,
                        serverName: form.server,
                    },
                    admin: false,
                    origin: "web",
                });
                const message = `Attack launched on ${result.host}:${result.port} for ${result.seconds}s using ${result.method}.`;
                if (acceptJson) ctx.json({ success: message });
                else back();
            } catch (error) {
                if (error instanceof HttpError && error.status < 500) {
                    fail(error.status, error.message);
                    return;
                }
                throw error;
            }
        },
        { guard: "webUser" }
    );

    app.get(
        "/web/api/hub/stats",
        async (ctx) => {
            const user = await requireWebUser(ctx);
            expireFinishedAttacks();
            const runningAttacks = await webDb.logs.findMany({
                where: { stopped: 0, time: { gt: 0 }, user: user.username },
                select: {
                    id: true,
                    user: true,
                    ip: true,
                    time: true,
                    method: true,
                    postdata: true,
                    handler: true,
                    date: true,
                    origin: true,
                },
                orderBy: { date: "desc" },
            });
            ctx.json({ runningAttacks });
        },
        { guard: "webUser" }
    );

    // --------------------------------------------------------------- profile
    app.get(
        "/web/profile",
        async (ctx) => {
            const user = await currentUser(ctx);
            const plan = hasActiveMembership(user)
                ? await webDb.plans.findUnique({ where: { ID: user.membership } })
                : null;
            ctx.htmlRaw(
                render("web-profile", {
                    meta: privateMeta("Profile | IPstress", "/web/profile"),
                    signedIn: true,
                    user,
                    plan,
                    expiry: plan
                        ? new Date(Number(user.expire) * 1000).toLocaleDateString("en-US")
                        : "No active plan",
                    refLink: user.ID > 0 ? `${env.siteOrigin}/web/register?ref=${user.ID}` : "N/A",
                    updated: ctx.query.get("updated") === "1",
                    error: ctx.query.get("error") ?? "",
                    flags: features,
                })
            );
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/profile/password",
        async (ctx) => {
            const user = await currentUser(ctx);
            const acceptJson = wantsJson(ctx);
            try {
                const f = await ctx.form();
                const oldP = f.old?.trim();
                const newP = f.new?.trim();
                const repP = f.rnew?.trim();
                if (!oldP || !newP || !repP) {
                    throw new HttpError(400, "All fields are required.");
                }
                if (!rateLimit("password:" + user.ID, 5, 3_600_000)) {
                    throw new HttpError(429, "Too many password changes. Try again later.");
                }
                if (newP.length < 10) {
                    throw new HttpError(400, "New password must be at least 10 characters.");
                }
                if (newP !== repP) throw new HttpError(400, "Passwords do not match.");
                const check = await verifyPassword(oldP, user.password);
                if (!check.ok) throw new HttpError(401, "Current password is incorrect.");
                const nextVersion = Number(user.sessionVersion) + 1;
                await webDb.users.update({
                    where: { ID: user.ID },
                    data: {
                        password: await bcrypt.hash(newP, 12),
                        sessionVersion: nextVersion,
                    },
                });
                // This browser proved the old password, so it keeps its session
                // under the new version. Every other session is now stale.
                await webSessions.save(ctx, {
                    userId: user.ID,
                    username: user.username,
                    rank: Number(user.rank),
                    sv: nextVersion,
                });
                if (acceptJson) {
                    ctx.json({ success: "Password changed successfully." });
                } else {
                    ctx.redirect("/web/profile?updated=1", 303);
                }
            } catch (error) {
                if (!acceptJson && error instanceof HttpError && error.status < 500) {
                    ctx.redirect("/web/profile?error=" + encodeURIComponent(error.message), 303);
                    return;
                }
                throw error;
            }
        },
        { guard: "webUser" }
    );

    // -------------------------------------------------------------- giftcards
    app.post(
        "/web/api/giftcards/redeem",
        async (ctx) => {
            if (!features.giftcards) {
                ctx.json({ error: "Gift cards are disabled." }, 403);
                return;
            }
            const user = await currentUser(ctx);
            if (!rateLimit("giftcard:" + user.ID, 5, 60 * 60_000)) {
                throw new HttpError(429, "Too many gift card attempts. Try again later.");
            }
            const f = await ctx.form();
            const code = f.code?.trim().toUpperCase();
            const acceptJson = wantsJson(ctx);
            try {
                if (!code) throw new HttpError(400, "Gift card code is required.");
                const result = await withLock("gift:" + code, async () => {
                    const card = await webDb.giftcards.findFirst({ where: { code, claimedby: 0 } });
                    if (!card)
                        throw new HttpError(400, "Invalid or already claimed gift card code.");
                    const plan = (await webDb.plans.findUnique({
                        where: { ID: card.planID },
                    })) as PlanRow | null;
                    if (!plan) {
                        throw new HttpError(
                            400,
                            "Plan associated with this gift card no longer exists."
                        );
                    }
                    const now = nowSeconds();
                    const term =
                        Number(card.termSeconds) > 0
                            ? Number(card.termSeconds)
                            : planTermSeconds(plan);
                    webSqlite.transaction(() => {
                        const claim = webSqlite
                            .prepare(
                                "update giftcards set claimedby = ?, dateClaimed = ? where ID = ? and claimedby = 0"
                            )
                            .run(user.ID, now, card.ID);
                        if (claim.changes !== 1) {
                            throw new HttpError(400, "Invalid or already claimed gift card code.");
                        }
                        const fresh = webSqlite
                            .prepare("select expire, membership from users where ID = ?")
                            .get(user.ID) as { expire?: number; membership?: number } | undefined;
                        if (!fresh) throw new HttpError(404, "User not found");
                        // A first purchase starts now; an active membership is
                        // extended instead of being replaced.
                        const active = Number(fresh.membership) > 0 && Number(fresh.expire) > now;
                        const base = active ? Math.max(now, Number(fresh.expire) || 0) : now;
                        webSqlite
                            .prepare("update users set membership = ?, expire = ? where ID = ?")
                            .run(plan.ID, base + term, user.ID);
                    })();
                    return plan.name;
                });
                if (acceptJson) {
                    ctx.json({ success: `Gift card redeemed! You now have the ${result} plan.` });
                } else {
                    ctx.redirect("/web/giftcards?redeemed=" + encodeURIComponent(result), 303);
                }
            } catch (error) {
                if (error instanceof HttpError && error.status < 500 && !acceptJson) {
                    ctx.redirect("/web/giftcards?error=" + encodeURIComponent(error.message), 303);
                    return;
                }
                throw error;
            }
        },
        { guard: "webUser" }
    );

    // -------------------------------------------------------------- affiliate
    app.get(
        "/web/api/affiliate",
        async (ctx) => {
            if (!features.affiliate) {
                ctx.json({ error: "Affiliate program is disabled." }, 403);
                return;
            }
            const user = await currentUser(ctx);
            const referralLink =
                user.ID > 0 ? `${env.siteOrigin}/web/register?ref=${user.ID}` : "N/A";
            const referralCount = await webDb.users.count({
                where: { referedBy: user.ID },
            });
            ctx.json({
                referralLink,
                referralCount,
                referralBalance: user.referralbalance,
            });
        },
        { guard: "webUser" }
    );

    // ------------------------------------------------------------------ wheel
    app.post(
        "/web/api/wheel/spin",
        async (ctx) => {
            if (!features.wheel) {
                ctx.json({ error: "The wheel is disabled." }, 403);
                return;
            }
            const user = await currentUser(ctx);
            // Balances are USD.
            const PRIZES = [
                { id: 0, name: "$10 Balance", points: 10 },
                { id: 1, name: "$5 Balance", points: 5 },
                { id: 2, name: "$50 Balance", points: 50 },
                { id: 3, name: "No Prize", points: 0 },
                { id: 4, name: "$20 Balance", points: 20 },
                { id: 5, name: "$15 Balance", points: 15 },
                { id: 6, name: "$100 Balance", points: 100 },
                { id: 7, name: "No Prize", points: 0 },
            ];
            if (!rateLimit("wheel:" + user.ID, 3, 60 * 60_000)) {
                throw new HttpError(429, "Too many spins. Try again later.");
            }
            const outcome = await withLock("wheel:" + user.ID, async () => {
                const last = await webDb.actions.findFirst({
                    where: { client: user.username, action: "wheel" },
                    orderBy: { date: "desc" },
                    select: { date: true },
                });
                const now = nowSeconds();
                if (last && now - Number(last.date) < 86400) {
                    throw new HttpError(
                        429,
                        `Wheel resets in ${Math.ceil((86400 - (now - Number(last.date))) / 3600)} hour(s).`
                    );
                }
                const prizeIndex = randomInt(0, PRIZES.length);
                const prize = PRIZES[prizeIndex];
                if (prize.points > 0) {
                    const fresh = await webDb.users.findUnique({
                        where: { ID: user.ID },
                        select: { referralbalance: true },
                    });
                    await webDb.users.update({
                        where: { ID: user.ID },
                        data: {
                            referralbalance: Number(fresh?.referralbalance ?? 0) + prize.points,
                        },
                    });
                }
                await webDb.actions.create({
                    data: { admin: "", client: user.username, action: "wheel", date: now },
                });
                return { prizeIndex, prize };
            });
            ctx.json({
                prize: outcome.prizeIndex,
                prizeName: outcome.prize.name,
                points: outcome.prize.points,
            });
        },
        { guard: "webUser" }
    );

    // ---------------------------------------------------------------- tickets
    app.get(
        "/web/tickets",
        async (ctx) => {
            const user = await currentUser(ctx);
            const tickets = await webDb.tickets.findMany({
                where: { username: user.username },
                orderBy: { date: "desc" },
            });
            ctx.htmlRaw(
                render("web-tickets", {
                    signedIn: true,
                    tickets,
                    meta: privateMeta("Tickets | IPstress", "/web/tickets"),
                })
            );
        },
        { guard: "webUser" }
    );

    app.get(
        "/web/tickets/:id",
        async (ctx) => {
            const user = await currentUser(ctx);
            const id = Number(ctx.params.id);
            const ticket = await webDb.tickets.findUnique({ where: { id } });
            if (!ticket) throw new HttpError(404, "Ticket not found");
            if (ticket.username !== user.username && Number(user.rank) < 1) {
                ctx.throw(403, "Forbidden");
            }
            const messages = await webDb.messages.findMany({
                where: { ticketid: id },
                orderBy: { date: "asc" },
            });
            ctx.htmlRaw(
                render("web-ticket", {
                    signedIn: true,
                    ticket,
                    messages,
                    meta: privateMeta(
                        `Ticket #${ticket.id} | IPstress`,
                        `/web/tickets/${ticket.id}`
                    ),
                })
            );
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/tickets",
        async (ctx) => {
            const user = await currentUser(ctx);
            if (!rateLimit("ticket-create:" + user.ID, 5, 60 * 60_000)) {
                throw new HttpError(429, "Too many tickets. Try again later.");
            }
            const f = await ctx.form();
            const subject = f.subject?.trim();
            const content = f.content?.trim();
            if (!subject || !content) {
                throw new HttpError(400, "Subject and content are required.");
            }
            if (subject.length > 200 || content.length > 10_000) {
                throw new HttpError(400, "Ticket is too long.");
            }
            const ticket = await webDb.tickets.create({
                data: {
                    subject,
                    content,
                    status: "Waiting for admin response",
                    username: user.username,
                    date: nowSeconds(),
                },
            });
            if (wantsJson(ctx)) {
                ctx.json({ success: "Ticket created successfully", id: ticket.id });
            } else {
                ctx.redirect("/web/tickets/" + ticket.id, 303);
            }
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/tickets/:id",
        async (ctx) => {
            const user = await currentUser(ctx);
            const ticketId = Number(ctx.params.id);
            const ticket = await webDb.tickets.findUnique({ where: { id: ticketId } });
            if (!ticket) throw new HttpError(404, "Ticket not found");
            if (user.username !== ticket.username && Number(user.rank) < 1) {
                ctx.throw(403, "Forbidden");
            }
            if (ticket.status === "Closed") {
                throw new HttpError(400, "Ticket is closed");
            }
            if (!rateLimit("ticket-reply:" + user.ID, 20, 60 * 60_000)) {
                throw new HttpError(429, "Too many replies. Try again later.");
            }
            const f = await ctx.form();
            const content = f.content?.trim();
            if (!content) throw new HttpError(400, "Reply content is required.");
            if (content.length > 10_000) throw new HttpError(400, "Reply is too long.");
            const now = nowSeconds();
            await webDb.messages.create({
                data: { ticketid: ticket.id, content, sender: user.username, date: now },
            });
            await webDb.tickets.update({
                where: { id: ticket.id },
                data: { status: "Waiting for admin response" },
            });
            if (wantsJson(ctx)) {
                ctx.json({ success: "Reply sent successfully" });
            } else {
                ctx.redirect("/web/tickets/" + ticket.id, 303);
            }
        },
        { guard: "webUser" }
    );
}
