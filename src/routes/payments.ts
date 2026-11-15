import { Application } from "../core/01-application";
import { Context } from "../core/03-context";
import { HttpError } from "../core/09-errors";
import { requireWebUser } from "./guards";
import { features } from "../config/features";
import { env } from "../config/env";
import { randomBytes } from "node:crypto";
import { webDb } from "../lib/db/web";
import { openSecret } from "../lib/secrets";

async function stripeClient(): Promise<any> {
    const key =
        process.env.STRIPE_SECRET_KEY ||
        openSecret(
            (await webDb.settings.findFirst({ select: { stripeSecretKey: true } }))?.stripeSecretKey
        );
    if (!key) return null;
    // Lazy require avoids Stripe SDK type resolution issues at compile time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StripeCtor = require("stripe");
    return new StripeCtor(key);
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
            const stripe = await stripeClient();
            if (!stripe) {
                fail(503, "Stripe is not configured.", "config");
                return;
            }
            const f = await ctx.form();
            const planId = parseInt(f.plan || "0", 10);
            const email = f.email?.trim() ?? "";
            if (!planId) throw new HttpError(400, "Invalid plan.");
            const plan = await webDb.plans.findUnique({ where: { ID: planId } });
            if (!plan || plan.price <= 0) throw new HttpError(404, "Plan not found.");
            const tid = genTid("STRIPE");
            const checkout = await stripe.checkout.sessions.create({
                mode: "payment",
                ...(email ? { customer_email: email } : {}),
                line_items: [
                    {
                        quantity: 1,
                        price_data: {
                            currency: "usd",
                            unit_amount: Math.round(plan.price * 100),
                            product_data: { name: plan.name + " membership" },
                        },
                    },
                ],
                metadata: { tid, userId: String(user.ID), planId: String(plan.ID) },
                success_url: new URL("/web/dashboard?purchased=1", env.siteOrigin).toString(),
                cancel_url: new URL("/web/plan", env.siteOrigin).toString(),
            });
            await webDb.payments.create({
                data: {
                    paid: 0,
                    plan: plan.ID,
                    user: user.ID,
                    email,
                    tid,
                    date: Math.floor(Date.now() / 1000),
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
            ctx.json({ received: true });
            return;
        }
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        const stripe = await stripeClient();
        if (!secret || !stripe)
            throw new HttpError(400, "Webhook signature verification is not configured.");
        const signature = ctx.raw.headers["stripe-signature"] as string | undefined;
        if (!signature) throw new HttpError(400, "Missing signature.");
        const raw = await new Promise<string>((resolve, reject) => {
            let data = "";
            ctx.raw.on("data", (c: Buffer) => {
                data += c.toString();
                if (data.length > 1_000_000) {
                    ctx.raw.destroy();
                    reject(new HttpError(413, "Webhook payload too large."));
                }
            });
            ctx.raw.on("end", () => resolve(data));
            ctx.raw.on("error", reject);
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let event: any;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            event = await (stripe as any).webhooks.constructEventAsync(raw, signature, secret);
        } catch {
            console.error("Stripe webhook signature FAILED");
            throw new HttpError(400, "Invalid signature.");
        }
        if (event.type === "checkout.session.completed") {
            const sess = event.data.object;
            const tid = sess.metadata?.tid;
            const userId = parseInt(sess.metadata?.userId || "0", 10);
            const planId = parseInt(sess.metadata?.planId || "0", 10);
            if (!tid || !userId || !planId) throw new HttpError(400, "Missing payment metadata.");
            if (sess.payment_status !== "paid")
                throw new HttpError(400, "Payment is not complete.");
            const plan = await webDb.plans.findUnique({ where: { ID: planId } });
            if (!plan) throw new HttpError(400, "Plan no longer exists.");
            const expected = Math.round(Number(plan.price) * 100);
            if (Number(sess.amount_total ?? 0) < expected || sess.currency !== "usd") {
                throw new HttpError(400, "Payment amount does not match the plan.");
            }
            const payment = await webDb.payments.findFirst({ where: { tid } });
            if (!payment || Number(payment.user) !== userId) {
                throw new HttpError(400, "Payment record not found.");
            }
            if (Number(payment.paid) === 0) {
                const days = Math.max(plan.length, 1);
                const unit = plan.unit === "hours" ? 3600 : 86400;
                await webDb.payments.update({
                    where: { ID: payment.ID },
                    data: { paid: Number(sess.amount_total ?? 0) / 100 },
                });
                await webDb.users.update({
                    where: { ID: userId },
                    data: { membership: planId, expire: now() + days * unit },
                });
            }
        }
        ctx.json({ received: true });
    });

    // PayPal and Bitcoin are disabled until server-side verification exists.
    // Client-supplied amounts must never be treated as paid.
    app.post(
        "/web/api/payments/paypal",
        async (ctx: Context) => {
            ctx.json({ error: "PayPal is not available yet." }, 503);
        },
        { guard: "webUser" }
    );

    app.post(
        "/web/api/payments/bitcoin",
        async (ctx: Context) => {
            ctx.json({ error: "Bitcoin is not available yet." }, 503);
        },
        { guard: "webUser" }
    );
}
function now(): number {
    return Math.floor(Date.now() / 1000);
}
