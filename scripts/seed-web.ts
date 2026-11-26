import "./load-env";
import { webDb } from "../src/lib/db/web";
import bcrypt from "bcryptjs";

function hashPassword(password: string): string {
    return bcrypt.hashSync(password, 12);
}

/**
 * Seed is create-only: re-running it must never overwrite operator edits
 * (settings, FAQ, plans, methods, accounts).
 */
async function main() {
    console.log("Seeding web database...");

    await webDb.settings.upsert({
        where: { sitename: "IPstress" },
        update: {},
        create: {
            sitename: "IPstress",
            stripePubKey: "",
            url: "http://localhost:3000",
            description: "Premium IP stress testing service",
            cooldown: 60,
            cooldownTime: 300,
            paypal: "",
            bitcoin: "",
            stripe: 0,
            maintaince: "0",
            rotation: 0,
            system: "public",
            maxattacks: 5,
            testboots: 1,
            cloudflare: 0,
            skype: "",
            key: "",
            issuerId: "",
            coinpayments: "",
            ipnSecret: "",
            google_site: "",
            google_secret: "",
            btc_address: "",
            secretKey: "",
            cbp: 0,
            paypal_email: "",
            theme: "default",
            logo: "/images/logo-icon.png",
            stripeSecretKey: "",
        },
    });
    console.log("  ok default settings present");

    // Max attack times increase with plan tier: 60 / 120 / 300 / 600 seconds.
    const plans = [
        {
            ID: 1,
            name: "Bronze",
            vip: 0,
            mbt: 60,
            unit: "days",
            length: 7,
            price: 5.99,
            concurrents: 1,
            private: 0,
        },
        {
            ID: 2,
            name: "Silver",
            vip: 0,
            mbt: 120,
            unit: "days",
            length: 30,
            price: 14.99,
            concurrents: 3,
            private: 0,
        },
        {
            ID: 3,
            name: "Gold",
            vip: 1,
            mbt: 300,
            unit: "days",
            length: 30,
            price: 29.99,
            concurrents: 5,
            private: 0,
        },
        {
            ID: 4,
            name: "Diamond",
            vip: 1,
            mbt: 600,
            unit: "days",
            length: 90,
            price: 74.99,
            concurrents: 10,
            private: 0,
        },
    ];

    for (const plan of plans) {
        const existing = await webDb.plans.findUnique({ where: { ID: plan.ID } });
        if (!existing) await webDb.plans.create({ data: plan });
    }
    console.log("  ok 4 plans present (create-only)");

    const methods = [
        {
            name: "UDP",
            fullname: "UDP Flood",
            type: "layer4",
            command: "./udp {host} {port} {time}",
        },
        {
            name: "TCP",
            fullname: "TCP Flood",
            type: "layer4",
            command: "./tcp {host} {port} {time}",
        },
        { name: "HTTP", fullname: "HTTP Flood", type: "layer7", command: "./http {target} {time}" },
    ];
    for (const method of methods) {
        const existing = await webDb.methods.findFirst({ where: { name: method.name } });
        if (!existing) await webDb.methods.create({ data: method });
    }
    console.log("  ok UDP/TCP/HTTP methods present (create-only)");

    // Operator account only when no operator exists. Re-running a seed must
    // never reset a live password.
    const hasAdmin = await webDb.users.findFirst({ where: { rank: { gte: 1 } } });
    if (!hasAdmin) {
        await webDb.users.create({
            data: {
                username: "admin",
                password: hashPassword("admin12345"),
                rank: 2,
                membership: 0,
                expire: 0,
                status: 0,
                referral: "",
                referralbalance: 0,
                testattack: 1,
                activity: 0,
                twoauth: 0,
                referedBy: 0,
                sessionVersion: 0,
            },
        });
        console.log("  ok operator created (admin / admin12345) - change it after first login");
    } else {
        console.log("  = operator account exists, left untouched");
    }

    await webDb.smtpsettings.upsert({
        where: { host: "smtp.example.com" },
        update: {},
        create: {
            host: "smtp.example.com",
            auth: "tls",
            username: "noreply@example.com",
            password: "smtp-password",
            port: 587,
        },
    });
    console.log("  ok SMTP settings present");

    const faqs = [
        {
            id: 1,
            question: "What is IP stress testing?",
            answer: "IP stress testing is a method of testing the resilience and stability of network infrastructure by simulating high traffic volumes.",
        },
        {
            id: 2,
            question: "Is this service legal?",
            answer: "Our service is intended for testing your own infrastructure only. You must have explicit permission to test any network you do not own.",
        },
        {
            id: 3,
            question: "How do I upgrade my plan?",
            answer: "Open the Plans page, choose a plan and pay by card through Stripe. Your plan activates as soon as the payment is confirmed.",
        },
        {
            id: 4,
            question: "Can I get a refund?",
            answer: "Refunds are handled on a case-by-case basis. Please contact support via the ticket system.",
        },
        {
            id: 5,
            question: "How do I reset my password?",
            answer: "Open a support ticket and the operator will reset it for you.",
        },
    ];

    for (const faq of faqs) {
        const existing = await webDb.faq.findUnique({ where: { id: faq.id } });
        if (!existing) await webDb.faq.create({ data: faq });
    }
    console.log("  ok FAQ entries present (edited entries kept)");

    console.log("Web database seeded successfully!");
}

main()
    .catch((e) => {
        console.error("Seed error:", e);
        process.exit(1);
    })
    .finally(async () => {
        await webDb.$disconnect();
    });
