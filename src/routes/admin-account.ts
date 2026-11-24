import { Application } from "../core/01-application";
import { HttpError } from "../core/09-errors";
import { render } from "../core/views";
import { mainSessions } from "./guards";
import { mainDb } from "../lib/db/main";
import { verifyPassword, hashPassword } from "../lib/passwords";

const USERNAME_RE = /^[A-Za-z0-9._-]{3,20}$/;

export function registerAdminAccountRoutes(app: Application): void {
    app.get(
        "/admin/account",
        async (ctx) => {
            const row = await mainDb.login.findFirst();
            ctx.htmlRaw(
                render("admin-account", {
                    username: row?.User ?? "",
                    saved: ctx.query.get("saved") === "1",
                    error: ctx.query.get("error") ?? "",
                })
            );
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/account",
        async (ctx) => {
            const body = await ctx.form();
            const current = String(body.current ?? "");
            const nextUsername = String(body.username ?? "").trim();
            const nextPassword = String(body.password ?? "");
            const confirm = String(body.confirm ?? "");
            const row = await mainDb.login.findFirst();
            if (!row) throw new HttpError(404, "Operator account not found.");
            const check = await verifyPassword(current, row.PW);
            if (!check.ok) throw new HttpError(403, "Current password is incorrect.");
            if (!USERNAME_RE.test(nextUsername)) {
                throw new HttpError(
                    400,
                    "Username must be 3-20 characters using letters, digits, dot, dash or underscore."
                );
            }
            const rows = await mainDb.login.findMany();
            if (
                rows.some(
                    (other) =>
                        other.User !== row.User &&
                        String(other.User).toLowerCase() === nextUsername.toLowerCase()
                )
            ) {
                throw new HttpError(409, "That username is already in use.");
            }
            if (nextPassword && nextPassword !== confirm) {
                throw new HttpError(400, "New passwords do not match.");
            }
            if (nextPassword && nextPassword.length < 10) {
                throw new HttpError(400, "New password must be at least 10 characters.");
            }
            const version = Number(row.sessionVersion) + 1;
            const pw = nextPassword ? await hashPassword(nextPassword) : row.PW;
            await mainDb.login.update({
                where: { User: row.User },
                data: { User: nextUsername, PW: pw, sessionVersion: version },
            });
            mainSessions.save(ctx, {
                islogin: true,
                username: nextUsername,
                sv: version,
            });
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: true });
            } else {
                ctx.redirect("/admin/account?saved=1", 303);
            }
        },
        { guard: "mainAdmin" }
    );
}
