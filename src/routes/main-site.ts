/**
 * MAIN SITE ROUTES - public pages + auth + submission intake.
 *
 * SECURITY POSTURE (parity with the hardened Next build):
 *   - /login and /submission are public pages.
 *   - POST /api/auth/login  -> bcrypt verify, rate-limited, sets signed cookie
 *   - GET  /api/auth/logout -> destroys session, redirects home
 *   - POST /api/submission  -> rate-limited, zod-validated, multipart upload,
 *                              writes pending row + domain flags + screenshot
 */

import { Application } from "../core/01-application";
import { Context } from "../core/03-context";
import { HttpError } from "../core/09-errors";
import { mainSessions } from "./guards";
import { render } from "../core/views";
import { loginSchema } from "../lib/validations/admin-auth";
import { submissionSchema } from "../lib/validations/submission";
import { rateLimit } from "../lib/rate-limit";
import { readMultipart } from "../lib/multipart";
import { detectImage, saveUpload } from "../lib/uploads";
import { withLock } from "../lib/lock";
import { verifyPassword } from "../lib/passwords";
import {
    createSubmission,
    createDomain,
    getNextSubmissionId,
    type CreateDomainInput,
} from "../server/queries/submissions";
import { mainDb } from "../lib/db/main";

export function registerMainSiteRoutes(app: Application): void {
    app.get("/login", async (ctx) => {
        ctx.htmlRaw(render("login", { error: ctx.query.get("error") ?? "" }));
    });

    app.post(
        "/api/auth/login",
        async (ctx) => {
            const asHtml = !String(ctx.raw.headers.accept ?? "").includes("application/json");
            if (!rateLimit("main-login:" + ctx.ip, 10, 60_000)) {
                if (asHtml) {
                    ctx.redirect("/login?error=rate", 303);
                    return;
                }
                throw new HttpError(429, "Too many login attempts. Try again in a minute.");
            }
            const form = await ctx.body(loginSchema);
            if (!rateLimit("main-login-user:" + form.username.toLowerCase(), 10, 60_000)) {
                if (asHtml) {
                    ctx.redirect("/login?error=rate", 303);
                    return;
                }
                throw new HttpError(429, "Too many login attempts. Try again in a minute.");
            }
            const user = await mainDb.login.findUnique({ where: { User: form.username } });
            // Always run a verification so unknown users take the same time.
            const check = await verifyPassword(
                form.password,
                user?.PW ?? "$2b$12$.5XkKkyMWCtIYiGjUqvHeuWjs5kNjl7nOYChlviJiHgVUgE4A.h6C"
            );
            if (user === null || !check.ok) {
                if (asHtml) {
                    ctx.redirect("/login?error=invalid", 303);
                    return;
                }
                throw new HttpError(401, "Invalid username or password.");
            }
            if (check.rehashed) {
                await mainDb.login.update({ where: { User: user.User }, data: { PW: check.rehashed } });
            }
            await mainSessions.save(ctx, { islogin: true });
            ctx.redirect("/admin", 303);
        },
        { guard: undefined }
    );

    app.get("/api/auth/logout", async (ctx) => {
        mainSessions.destroy(ctx);
        ctx.redirect("/", 303);
    });

    app.get("/submission", async (ctx) => {
        ctx.htmlRaw(render("submission", { received: ctx.query.get("received") === "1" }));
    });

    app.post("/api/submission", async (ctx: Context) => {
        if (!rateLimit("submission:" + ctx.ip, 5, 3_600_000)) {
            throw new HttpError(429, "Too many submissions. Try again later.");
        }

        const { fields, file } = await readMultipart(ctx);
        const parsed = submissionSchema.safeParse(fields);
        if (!parsed.success) {
            throw new HttpError(400, parsed.error.issues[0]?.message ?? "Validation failed.");
        }
        if (fields.website || fields.url) {
            // Honeypot: real users never fill this hidden field.
            ctx.json({ success: true, message: "Submission received." });
            return;
        }
        if (file && file.data.length > 0 && !detectImage(file.data)) {
            throw new HttpError(400, "Screenshot must be a PNG, JPEG or WebP image.");
        }

        const d = parsed.data;
        const domainFlags = (
            [
                "R",
                "TP",
                "MT",
                "AR",
                "U",
                "MDL",
                "RA",
                "RoTech",
                "LS",
                "RoThink",
                "EoST",
                "EF",
                "RTE",
                "DLoI",
                "RaAoC",
            ] as const
        ).map((col) => [col, fields[col] === "true"]) as Array<[keyof CreateDomainInput, boolean]>;

        const row = await withLock("submission-id", async () => {
            const id = await getNextSubmissionId();
            const created = await createSubmission({
                id,
                techname: d.techname,
                link: d.link,
                displaytext: d.displaytext,
                tl1_desc: d.tl1_desc ?? "",
                tl2_desc: d.tl2_desc ?? "",
                tl3_desc: d.tl3_desc ?? "",
                tl4_desc: d.tl4_desc ?? "",
                username: d.username ?? "",
                contact: d.contact ?? "",
                accepted: false,
            });
            await createDomain({ id, ...Object.fromEntries(domainFlags) } as CreateDomainInput);
            return created;
        });

        if (file && file.data.length > 0) {
            saveUpload(row.id, file.data);
        }

        if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
            ctx.json({ success: true, id: row.id, message: "Submission received." });
        } else {
            ctx.redirect("/submission?received=1", 303);
        }
    });
}
