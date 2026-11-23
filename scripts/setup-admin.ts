try {
    process.loadEnvFile();
} catch {
    /* real environment wins */
}
import bcrypt from "bcryptjs";
import { mainDb } from "../src/lib/db/main";
import { webDb } from "../src/lib/db/web";

// Creates, rotates or renames the operator credentials for BOTH subprojects.
// Re-running after `db:init` is supported: the existing account is updated in
// place (session ids survive), so the username and password can change at any
// time. Usage:
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

    const loginRows = await mainDb.login.findMany();
    const named = loginRows.find((row) => row.User === username);
    if (named) {
        await mainDb.login.update({ where: { User: named.User }, data: { PW: hash } });
    } else if (loginRows.length > 0) {
        await mainDb.login.update({
            where: { User: loginRows[0].User },
            data: { User: username, PW: hash },
        });
    } else {
        await mainDb.login.create({ data: { User: username, PW: hash } });
    }

    const namedAdmin = await webDb.users.findFirst({
        where: { username, rank: { gte: 1 } },
    });
    const namedUser = namedAdmin ? null : await webDb.users.findFirst({ where: { username } });
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
            },
        });
    }

    console.log(`Operator credentials set for "${username}" in both databases.`);
    await mainDb.$disconnect();
    await webDb.$disconnect();
}

main().catch((e) => {
    console.error("Setup failed:", e);
    process.exit(1);
});
