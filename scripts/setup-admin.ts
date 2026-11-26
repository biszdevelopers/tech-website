import "./load-env";
import bcrypt from "bcryptjs";
import { webDb } from "../src/lib/db/web";

// Configures the IPstress web administrator. The tech-directory operator is
// read directly from ADMIN_USERNAME/ADMIN_PASSWORD in .env at startup, so no
// database row is written for it.
// Usage:
//   ADMIN_USERNAME=admin ADMIN_PASSWORD=<min 10 chars> pnpm run setup

async function main(): Promise<void> {
    const username = (process.env.ADMIN_USERNAME ?? "").trim();
    const password = process.env.ADMIN_PASSWORD;

    if (!username || !password) {
        console.error("ADMIN_USERNAME and ADMIN_PASSWORD env vars are required.");
        process.exit(1);
    }
    if (!/^[A-Za-z0-9._-]{3,20}$/.test(username)) {
        console.error("ADMIN_USERNAME must be 3-20 characters (letters, digits, . _ -).");
        process.exit(1);
    }
    if (password.length < 10) {
        console.error("ADMIN_PASSWORD must be at least 10 characters.");
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 12);

    const webUsers = await webDb.users.findMany();
    const namedAdmin = webUsers.find(
        (row) =>
            Number(row.rank) >= 1 && String(row.username).toLowerCase() === username.toLowerCase()
    );
    const namedUser = namedAdmin
        ? null
        : webUsers.find((row) => String(row.username).toLowerCase() === username.toLowerCase());
    if (namedUser && process.env.ADMIN_FORCE_PROMOTE !== "1") {
        console.error(
            `"${username}" belongs to a normal user. Set ADMIN_FORCE_PROMOTE=1 to promote it, or choose another username.`
        );
        process.exit(1);
    }
    const webUser =
        namedAdmin ??
        namedUser ??
        (await webDb.users.findFirst({
            where: { rank: { gte: 1 } },
            orderBy: { ID: "asc" },
        }));
    if (webUser) {
        await webDb.users.update({
            where: { ID: webUser.ID },
            data: {
                username,
                password: hash,
                rank: Math.max(1, Number(webUser.rank)),
                sessionVersion: Number(webUser.sessionVersion) + 1,
            },
        });
    } else {
        await webDb.users.create({
            data: {
                username,
                password: hash,
                rank: 2,
                membership: 0,
                expire: 9999999999,
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
    }

    console.log(`IPstress web administrator set for "${username}".`);
    console.log(
        "The tech-directory operator uses ADMIN_USERNAME/ADMIN_PASSWORD from .env; restart to apply changes."
    );
    await webDb.$disconnect();
}

main().catch((e) => {
    console.error("Setup failed:", e);
    process.exit(1);
});
