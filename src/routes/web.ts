/**
 * ============================================================================
 * WEB ROUTES - SaaS auth APIs, hub, profile, tickets, giftcards, affiliate,
 * wheel. Pages render via views/web-pages.ts; every handler below is a direct
 * port of the audited Next.js route handlers (same guards, limits, responses).
 * ============================================================================
 */

import { Application } from "../core/01-application";
import { Context } from "../core/03-context";
import { HttpError } from "../core/09-errors";
import { webSessions, requireWebUser } from "./guards";
import { features } from "../config/features";
import { env } from "../config/env";
import { rateLimit } from "../lib/rate-limit";
import { webDb } from "../lib/db/web";
import { webLoginSchema, webRegisterSchema } from "../lib/validations/web-auth";
import { render } from "../core/views";
import { randomInt } from "node:crypto";
import { withLock } from "../lib/lock";
import { launchAttack } from "../server/attacks";
import { verifyPassword } from "../lib/passwords";
import bcrypt from "bcryptjs";

type Body = Record<string, unknown>;

/** Constant hash so unknown usernames cost the same as wrong passwords. */
const DUMMY_HASH = "$2b$12$.5XkKkyMWCtIYiGjUqvHeuWjs5kNjl7nOYChlviJiHgVUgE4A.h6C";

/** Shared guard: valid session + existing user row; returns the user. */
async function currentUser(ctx: Context) {
    const session = await requireWebUser(ctx);
    const user = await webDb.users.findUnique({ where: { ID: session.userId! } });
    if (!user) ctx.throw(404, "User not found");
    return user;
}

export function registerWebRoutes(app: Application): void {
    // ------------------------------------------------------------------ auth
    app.post("/web/api/auth/login", async (ctx) => {
        const asHtml = !String(ctx.raw.headers.accept ?? "").includes("application/json");
        if (!rateLimit("web-login:" + ctx.ip, 10, 60_000)) {
            if (asHtml) {
                ctx.redirect("/web/login?error=rate", 303);
                return;
            }
            throw new HttpError(429, "Too many login attempts. Try again in a minute.");
        }
        const form = await ctx.body(webLoginSchema);
        if (!rateLimit("web-login-user:" + form.username.toLowerCase(), 10, 60_000)) {
            if (asHtml) {
                ctx.redirect("/web/login?error=rate", 303);
                return;
            }
            throw new HttpError(429, "Too many login attempts. Try again in a minute.");
        }
        const user = await webDb.users.findFirst({ where: { username: form.username } });
        const check = await verifyPassword(form.password, user?.password ?? DUMMY_HASH);
        if (!user || !check.ok) {
            if (asHtml) {
                ctx.redirect("/web/login?error=invalid", 303);
                return;
            }
            throw new HttpError(401, "Invalid username or password.");
        }
        if (check.rehashed) {
            await webDb.users.update({ where: { ID: user.ID }, data: { password: check.rehashed } });
        }
        if (Number(user.status) === 1) {
            if (asHtml) {
                ctx.redirect("/web/login?error=banned", 303);
                return;
            }
            throw new HttpError(403, "Your account has been banned.");
        }
        await webSessions.save(ctx, {
            userId: user.ID,
            username: user.username,
            rank: Number(user.rank),
        });
        ctx.redirect("/web/dashboard", 303);
    });

    app.get("/web/api/auth/logout", async (ctx) => {
        webSessions.destroy(ctx);
        ctx.redirect("/web/login", 303);
    });

    app.post("/web/api/auth/register", async (ctx) => {
        if (!rateLimit("register:" + ctx.ip, 5, 3_600_000)) {
            throw new HttpError(429, "Too many registration attempts. Try again later.");
        }
        const form = await ctx.body();
        const parsed = webRegisterSchema.safeParse(form);
        if (!parsed.success) {
            throw new HttpError(400, parsed.error.issues[0]?.message ?? "Validation failed");
        }
        // Optional reCAPTCHA when keys are configured.
        const recaptcha = String((form as Body)["g-recaptcha-response"] ?? "");
        const secret = process.env.RECAPTCHA_SECRET_KEY;
        if (features.recaptcha && secret) {
            if (!recaptcha) throw new HttpError(400, "Captcha verification is required.");
            const params = new URLSearchParams({ secret, response: recaptcha });
            const verify = await fetch("https://www.google.com/recaptcha/api/siteverify", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: params.toString(),
            }).then((r) => r.json() as Promise<{ success?: boolean }>);
            if (!verify.success) throw new HttpError(400, "Captcha verification failed.");
        }

        const referrerId = Number((form as Body).ref ?? 0);
        const referrer =
            Number.isFinite(referrerId) && referrerId > 0
                ? await webDb.users.findUnique({ where: { ID: referrerId }, select: { ID: true } })
                : null;

        const hashedPassword = await bcrypt.hash(parsed.data.password, 12);
        const trialDate = new Date();
        trialDate.setDate(trialDate.getDate() + 7);
        const username = parsed.data.username;
        const newUser = await withLock("user:" + username.toLowerCase(), async () => {
            const existing = await webDb.users.findFirst({ where: { username } });
            if (existing) throw new HttpError(409, "Username is already taken");
            return webDb.users.create({
                data: {
                    username,
                    password: hashedPassword,
                    rank: 0,
                    membership: 0,
                    expire: Math.floor(trialDate.getTime() / 1000),
                    status: 0,
                    referral: "0",
                    referralbalance: 0,
                    testattack: 0,
                    activity: 0,
                    twoauth: 0,
                    referedBy: referrer ? referrer.ID : 0,
                },
            });
        });
        await webSessions.save(ctx, {
            userId: newUser.ID,
            username: newUser.username,
            rank: Number(newUser.rank),
        });
        if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
            ctx.json({ success: "You have successfully registered! Redirecting..." });
        } else {
            ctx.redirect("/web/dashboard", 303);
        }
    });

    // ------------------------------------------------------------- dashboard
    app.get(
        "/web/dashboard",
        async (ctx) => {
            const user = await currentUser(ctx);
            const plan = user.membership
                ? await webDb.plans.findUnique({ where: { ID: user.membership } })
                : null;
            const runningAttacks = await webDb.logs.count({
                where: { user: user.username, stopped: 0, time: { gt: 0 } },
            });
            const totalAttacks = await webDb.logs.count({ where: { user: user.username } });
            const planName = plan ? plan.name : "No membership";
            const maxTime = plan ? `${plan.mbt}s` : "No membership";
            const maxConc = String(plan?.concurrents ?? "-");
            const exp = new Date(user.expire * 1000).toLocaleDateString("en-US");
            ctx.htmlRaw(
                render("web-dashboard", {
                    planName,
                    maxTime,
                    maxConcurrents: maxConc,
                    expiry: exp,
                    runningAttacks,
                    totalAttacks,
                    isAdmin: Number(user.rank) >= 1,
                })
            );
        },
        { guard: "webUser" }
    );

    // ------------------------------------------------------------------ hub
    app.get(
        "/web/hub",
        async (ctx) => {
            await requireWebUser(ctx);
            const [methods, servers] = await Promise.all([
                webDb.methods.findMany({
                    select: { id: true, name: true, fullname: true },
                    orderBy: { name: "asc" },
                }),
                webDb.api.findMany({
                    select: { id: true, name: true, slots: true },
                    orderBy: { name: "asc" },
                }),
            ]);
            ctx.htmlRaw(
                render("web-hub", { methods: methods as never[], servers: servers as never[] })
            );
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/hub",
        async (ctx) => {
            if (!features.ipstress) {
                ctx.json({ error: "This feature is disabled." }, 403);
                return;
            }
            if (!rateLimit("hub:" + ctx.ip, 20, 60_000)) {
                ctx.json({ error: "Rate limit exceeded." }, 429);
                return;
            }
            const user = await currentUser(ctx);
            if (Number(user.membership) === 0) {
                ctx.json({ error: "You need an active membership to launch attacks." }, 403);
                return;
            }
            const now = Math.floor(Date.now() / 1000);
            if (user.expire && user.expire < now) {
                ctx.json({ error: "Your membership has expired." }, 403);
                return;
            }
            const plan = await webDb.plans.findUnique({ where: { ID: user.membership } });
            if (!plan) throw new HttpError(500, "Your plan no longer exists.");

            const form = await ctx.form();
            if (!form.host || !form.time || !form.method) {
                throw new HttpError(400, "Host, time, and method are required.");
            }
            try {
                const result = await launchAttack({
                    username: user.username,
                    plan: { mbt: Number(plan.mbt), concurrents: Number(plan.concurrents) },
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
                ctx.json({
                    success: `Attack launched on ${result.host}:${result.port} for ${result.seconds}s using ${result.method}.`,
                });
            } catch (error) {
                if (error instanceof HttpError && error.status < 500) {
                    ctx.json({ error: error.message }, error.status);
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
            const plan = user.membership
                ? await webDb.plans.findUnique({ where: { ID: user.membership } })
                : null;
            ctx.htmlRaw(
                render("web-profile", {
                    user,
                    plan,
                    expiry: new Date(user.expire * 1000).toLocaleDateString("en-US"),
                    refLink: user.referral
                        ? `${env.siteOrigin}/web/register?ref=${user.referral}`
                        : "N/A",
                })
            );
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/profile/password",
        async (ctx) => {
            const user = await currentUser(ctx);
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
            await webDb.users.update({
                where: { ID: user.ID },
                data: { password: await bcrypt.hash(newP, 12) },
            });
            ctx.json({ success: "Password changed successfully." });
        },
        { guard: "webUser" }
    );

    // -------------------------------------------------------------- giftcards
    app.post(
        "/web/api/giftcards/redeem",
        async (ctx) => {
            const user = await currentUser(ctx);
            if (!rateLimit("giftcard:" + user.ID, 5, 60 * 60_000)) {
                throw new HttpError(429, "Too many gift card attempts. Try again later.");
            }
            const f = await ctx.form();
            const code = f.code?.trim().toUpperCase();
            if (!code) throw new HttpError(400, "Gift card code is required.");
            const result = await withLock("gift:" + code, async () => {
                const card = await webDb.giftcards.findFirst({ where: { code, claimedby: 0 } });
                if (!card) throw new HttpError(400, "Invalid or already claimed gift card code.");
                const plan = await webDb.plans.findUnique({ where: { ID: card.planID } });
                if (!plan) {
                    throw new HttpError(400, "Plan associated with this gift card no longer exists.");
                }
                const now = Math.floor(Date.now() / 1000);
                await webDb.giftcards.update({
                    where: { ID: card.ID },
                    data: { claimedby: user.ID, dateClaimed: now },
                });
                await webDb.users.update({
                    where: { ID: user.ID },
                    data: { membership: plan.ID, expire: now + plan.length * 86400 },
                });
                return plan.name;
            });
            ctx.json({ success: `Gift card redeemed! You now have the ${result} plan.` });
        },
        { guard: "webUser" }
    );

    // -------------------------------------------------------------- affiliate
    app.get(
        "/web/api/affiliate",
        async (ctx) => {
            const user = await currentUser(ctx);
            const referralLink = user.referral
                ? `${env.siteOrigin}/web/register?ref=${user.referral}`
                : "N/A";
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
            const user = await currentUser(ctx);
            const PRIZES = [
                { id: 0, name: "10\u00a5 Balance", points: 10 },
                { id: 1, name: "5 Extra Attack Seconds", points: 0 },
                { id: 2, name: "50\u00a5 Balance", points: 50 },
                { id: 3, name: "No Prize", points: 0 },
                { id: 4, name: "20\u00a5 Balance", points: 20 },
                { id: 5, name: "1 Hour VIP", points: 0 },
                { id: 6, name: "100\u00a5 Balance", points: 100 },
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
                const now = Math.floor(Date.now() / 1000);
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
                        data: { referralbalance: Number(fresh?.referralbalance ?? 0) + prize.points },
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
            ctx.htmlRaw(render("web-tickets", { tickets }));
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
            ctx.htmlRaw(render("web-ticket", { ticket, messages }));
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
                    date: Math.floor(Date.now() / 1000),
                },
            });
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
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
            const now = Math.floor(Date.now() / 1000);
            await webDb.messages.create({
                data: { ticketid: ticket.id, content, sender: user.username, date: now },
            });
            await webDb.tickets.update({
                where: { id: ticket.id },
                data: { status: "Waiting for admin response" },
            });
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: "Reply sent successfully" });
            } else {
                ctx.redirect("/web/tickets/" + ticket.id, 303);
            }
        },
        { guard: "webUser" }
    );
}
