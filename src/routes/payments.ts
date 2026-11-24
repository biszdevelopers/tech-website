import { Application } from "../core/01-application";
import { Context } from "../core/03-context";
import { HttpError } from "../core/09-errors";
import { requireWebUser } from "./guards";
import { features } from "../config/features";
import { env } from "../config/env";
import { randomBytes } from "node:crypto";
import { webDb, webSqlite } from "../lib/db/web";
import { openSecret } from "../lib/secrets";
import { planTermSeconds } from "./web";

async function stripeClient(): Promise<any> {
    const key =
        process.env.STRIPE_SECRET_KEY ||
        openSecret(
            (await webDb.settings.findFirst({ select: { stripeSecretKey: true } }))?.stripeSecretKey
        );
    if (!key) return null;
    try {
        // Lazy require keeps Stripe out of the boot path and lets the app run
        // without the SDK when payments are disabled.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const StripeCtor = require("stripe");
        return new StripeCtor(key);
    } catch {
        return null;
    }
}

function webhookSecret(): string {
    return process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
}

function genTid(prefix: string): string {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(4)
        .toString("hex")
        .toUpperCase()}`;
}

async function currentUser(ctx: Context) {
    const session = await requireWebUser(ctx);
    const user = await webDb.users.findUnique({ where: { ID: session.userId! } });
    if (!user) ctx.throw(404, "User not found");
    return user;
}

export function registerPaymentRoutes(app: Application): void {
    app.post(
        "/web/api/payments/stripe",
        async (ctx: Context) => {
            const acceptJson = String(ctx.raw.headers.accept ?? "").includes("application/json");
            const fail = (status: number, message: string, reason: string): void => {
                if (acceptJson) ctx.json({ error: message }, status);
                else ctx.redirect("/web/plan?error=" + reason, 303);
            };
            if (!features.payments) {
                fail(403, "Payments are disabled.", "disabled");
                return;
            }
            const user = await currentUser(ctx);
            // Without a webhook secret there is no way to prove a payment was
            // paid; refusing checkout beats taking money we cannot fulfil.
            if (!webhookSecret()) {
                fail(503, "Stripe is not configured.", "config");
                return;
            }
            const stripe = await stripeClient();
            if (!stripe) {
                fail(503, "Stripe is not configured.", "config");
                return;
            }
            const f = await ctx.form();
            const planId = parseInt(f.plan || "0", 10);
            const email = f.email?.trim() ?? "";
            if (!Number.isInteger(planId) || planId <= 0) throw new HttpError(400, "Invalid plan.");
            const plan = await webDb.plans.findUnique({ where: { ID: planId } });
            if (!plan || Number(plan.price) <= 0) throw new HttpError(404, "Plan not found.");
            if (Number(plan.private) === 1 && Number(user.rank) < 1) {
                throw new HttpError(404, "Plan not found.");
            }
            const amount = Math.round(Number(plan.price) * 100);
            const termSeconds = planTermSeconds(plan);
            const tid = genTid("STRIPE");
            let checkout: { url?: string | null };
            try {
                checkout = await stripe.checkout.sessions.create({
                    mode: "payment",
                    ...(email ? { customer_email: email } : {}),
                    line_items: [
                        {
                            quantity: 1,
                            price_data: {
                                currency: "usd",
                                unit_amount: amount,
                                product_data: { name: plan.name + " membership" },
                            },
                        },
                    ],
                    metadata: { tid, userId: String(user.ID), planId: String(plan.ID) },
                    success_url: new URL("/web/dashboard?purchased=1", env.siteOrigin).toString(),
                    cancel_url: new URL("/web/plan", env.siteOrigin).toString(),
                });
            } catch (error) {
                console.error(
                    JSON.stringify({
                        level: "error",
                        msg: "stripe checkout failed",
                        reason: error instanceof Error ? error.message : String(error),
                    })
                );
                fail(502, "Stripe could not start the checkout.", "config");
                return;
            }
            await webDb.payments.create({
                data: {
                    paid: 0,
                    plan: plan.ID,
                    user: user.ID,
                    email,
                    tid,
                    date: Math.floor(Date.now() / 1000),
                    amount,
                    currency: "usd",
                    // Snapshot the term sold: a later plan edit must not change
                    // what this checkout grants.
                    termSeconds,
                },
            });
            if (!acceptJson) {
                if (checkout.url) ctx.redirect(checkout.url, 303);
                else fail(502, "Stripe did not return a checkout URL.", "config");
                return;
            }
            ctx.json({
                status: "pending",
                message: "Complete payment on Stripe.",
                tid,
                checkout_url: checkout.url,
            });
        },
        { guard: "webUser" }
    );

    // Stripe webhook: reads raw body BEFORE any parser touches it.
    app.post("/web/api/payments/stripe/webhook", async (ctx: Context) => {
        if (!features.payments) {
            // 503 keeps Stripe retrying, so a payment completed while the kill
            // switch is on is granted after it is turned back on.
            throw new HttpError(503, "Payments are temporarily disabled.");
        }
        const secret = webhookSecret();
        if (!secret) {
            // Stripe retries 5xx; a 400 here would permanently drop revenue.
            throw new HttpError(503, "Webhook signature verification is not configured.");
        }
        const stripe = await stripeClient();
        if (!stripe) throw new HttpError(503, "Stripe is not configured.");
        const signature = ctx.raw.headers["stripe-signature"] as string | undefined;
        if (!signature) throw new HttpError(400, "Missing signature.");

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of ctx.raw) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += buffer.length;
            if (size > 1_000_000) {
                ctx.raw.destroy();
                throw new HttpError(413, "Webhook payload too large.");
            }
            chunks.push(buffer);
        }
        const raw = Buffer.concat(chunks).toString("utf8");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let event: any;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            event = await (stripe as any).webhooks.constructEventAsync(raw, signature, secret);
        } catch {
            console.error("Stripe webhook signature FAILED");
            throw new HttpError(400, "Invalid signature.");
        }

        const paidEvents = new Set([
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
        ]);
        if (paidEvents.has(event.type)) {
            const sess = event.data.object;
            const tid = String(sess.metadata?.tid ?? "");
            const userId = parseInt(sess.metadata?.userId || "0", 10);
            const planId = parseInt(sess.metadata?.planId || "0", 10);
            if (!tid || !userId || !planId) throw new HttpError(400, "Missing payment metadata.");
            if (sess.payment_status !== "paid") {
                // Async payment methods confirm later; wait for the success event.
                ctx.json({ received: true });
                return;
            }

            const plan = await webDb.plans.findUnique({ where: { ID: planId } });
            const payment = await webDb.payments.findFirst({ where: { tid } });
            if (!payment || Number(payment.user) !== userId || Number(payment.plan) !== planId) {
                throw new HttpError(400, "Payment record not found.");
            }
            // Compare against the amount captured at checkout, not today's
            // price; a price edit between checkout and webhook must not reject
            // a legitimate payment.
            const expected =
                Number(payment.amount) > 0
                    ? Number(payment.amount)
                    : plan
                      ? Math.round(Number(plan.price) * 100)
                      : 0;
            const charged = Number(sess.amount_total ?? 0);
            if (charged < expected || String(sess.currency).toLowerCase() !== "usd") {
                throw new HttpError(400, "Payment amount does not match the plan.");
            }

            const term =
                Number(payment.termSeconds) > 0
                    ? Number(payment.termSeconds)
                    : plan
                      ? planTermSeconds(plan)
                      : 0;
            if (term <= 0) throw new HttpError(400, "Payment has no billable term.");

            const nowSec = Math.floor(Date.now() / 1000);
            webSqlite.transaction(() => {
                const current = webSqlite
                    .prepare("select paid, ID, termSeconds from payments where tid = ?")
                    .get(tid) as { paid?: number; ID?: number; termSeconds?: number } | undefined;
                if (!current?.ID) throw new HttpError(400, "Payment record not found.");
                if (Number(current.paid) > 0) return; // replay: already fulfilled
                const user = webSqlite
                    .prepare("select expire, membership, referedBy from users where ID = ?")
                    .get(userId) as
                    { expire?: number; membership?: number; referedBy?: number } | undefined;
                if (!user) throw new HttpError(400, "User no longer exists.");
                const updated = webSqlite
                    .prepare("update payments set paid = ? where ID = ? and paid = 0")
                    .run(charged / 100, current.ID);
                if (updated.changes !== 1) return; // another delivery won

                // Affiliate commission: 10% of the captured amount, credited
                // exactly once per fulfilled payment, never to the buyer.
                const referrerId = Number(user.referedBy ?? 0);
                if (referrerId > 0 && referrerId !== userId) {
                    // charged is cents; referralbalance is a USD balance.
                    const commission = Math.round(charged / 10) / 100;
                    if (commission > 0) {
                        webSqlite
                            .prepare(
                                "update users set referralbalance = referralbalance + ? where ID = ?"
                            )
                            .run(commission, referrerId);
                    }
                }

                // A first purchase starts now; an active membership is extended
                // from its current expiry instead of being replaced.
                const active = Number(user.membership) > 0 && Number(user.expire) > nowSec;
                const base = active ? Math.max(nowSec, Number(user.expire) || 0) : nowSec;
                const paidTerm =
                    Number(current.termSeconds) > 0 ? Number(current.termSeconds) : term;
                webSqlite
                    .prepare("update users set membership = ?, expire = ? where ID = ?")
                    .run(planId, base + paidTerm, userId);
            })();
        }
        ctx.json({ received: true });
    });

    // PayPal and Bitcoin are disabled until server-side verification exists.
    // Client-supplied amounts must never be treated as paid.
    app.post(
        "/web/api/payments/paypal",
        async (ctx: Context) => {
            ctx.json({ error: "PayPal is not available." }, 503);
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/payments/bitcoin",
        async (ctx: Context) => {
            ctx.json({ error: "Bitcoin is not available." }, 503);
        },
        { guard: "webUser" }
    );
}
