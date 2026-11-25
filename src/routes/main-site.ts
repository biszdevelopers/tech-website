/**
 * MAIN SITE ROUTES - public pages, operator auth and submission intake.
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
import { adminPasswordMatches, adminSessionVersion, adminUsernameMatches } from "../lib/admin-auth";
import { env } from "../config/env";
import { parseResourceLines } from "../lib/resources";
import { categorySelection } from "../lib/categories";
import { strandColumnNames } from "../lib/tl-config";
import {
    createToolBundle,
    getNextSubmissionId,
    type CreateDomainInput,
} from "../server/queries/submissions";
import { buildPageMeta, websiteLd } from "../lib/seo";

const SUBMISSION_META = buildPageMeta({
    title: "Submit a Tech Tool | BIBS-C Tech Tools",
    description: "Suggest a teaching technology tool for the BIBS-C directory.",
    path: "/submission",
    robots: "public",
    jsonLd: [websiteLd()],
});

function wantsJson(ctx: Context): boolean {
    return String(ctx.raw.headers.accept ?? "").includes("application/json");
}

function sameSubmissionSuccess(ctx: Context, id?: number): void {
    if (wantsJson(ctx)) {
        ctx.json({ success: true, id, message: "Submission received." });
    } else {
        ctx.redirect("/submission?received=1", 303);
    }
}

export function registerMainSiteRoutes(app: Application): void {
    app.get("/login", async (ctx) => {
        ctx.htmlRaw(render("login", { error: ctx.query.get("error") ?? "" }));
    });

    app.post(
        "/api/auth/login",
        async (ctx) => {
            const asHtml = !wantsJson(ctx);
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
            const usernameOk = adminUsernameMatches(form.username);
            const passwordOk = adminPasswordMatches(form.password);
            if (!usernameOk || !passwordOk) {
                if (asHtml) {
                    ctx.redirect("/login?error=invalid", 303);
                    return;
                }
                throw new HttpError(401, "Invalid username or password.");
            }
            await mainSessions.save(ctx, {
                islogin: true,
                username: env.adminUsername,
                sv: adminSessionVersion(),
            });
            ctx.redirect("/admin", 303);
        },
        { guard: undefined }
    );

    app.post("/api/auth/logout", async (ctx) => {
        mainSessions.destroy(ctx);
        ctx.redirect("/", 303);
    });

    app.get("/submission", async (ctx) => {
        ctx.htmlRaw(
            render("submission", {
                received: ctx.query.get("received") === "1",
                error:
                    ctx.query.get("error") === "csrf"
                        ? "Your form expired before it was sent. Please submit it again."
                        : "",
                meta: SUBMISSION_META,
            })
        );
    });

    app.post("/api/submission", async (ctx: Context) => {
        const { fields, file } = await readMultipart(ctx);
        if (fields.website || fields.url) {
            // Honeypot: look exactly like the normal success path.
            sameSubmissionSuccess(ctx);
            return;
        }

        const parsed = submissionSchema.safeParse(fields);
        if (!parsed.success) {
            const error = parsed.error.issues[0]?.message ?? "Validation failed.";
            if (wantsJson(ctx)) throw new HttpError(400, error);
            ctx.htmlRaw(
                render("submission", {
                    received: false,
                    error,
                    values: fields,
                    meta: SUBMISSION_META,
                }),
                400
            );
            return;
        }

        const resourceResult = parseResourceLines(parsed.data.resources ?? "");
        if (!resourceResult.ok) {
            if (wantsJson(ctx)) throw new HttpError(400, resourceResult.error);
            ctx.htmlRaw(
                render("submission", {
                    received: false,
                    error: resourceResult.error,
                    values: fields,
                    meta: SUBMISSION_META,
                }),
                400
            );
            return;
        }

        const d = parsed.data;
        const domainColumns = strandColumnNames();
        const flags = domainColumns.map(
            (column) => [column, fields[column] === "true"] as [string, boolean]
        );
        const hasWriteup = Boolean((d.tl5_desc ?? "").trim() || (d.tl6_desc ?? "").trim());
        if (!flags.some(([, value]) => value) && !hasWriteup) {
            const error = "Choose at least one TL1-TL4 strand or add a TL5/TL6 write-up.";
            if (wantsJson(ctx)) throw new HttpError(400, error);
            ctx.htmlRaw(
                render("submission", {
                    received: false,
                    error,
                    values: fields,
                    meta: SUBMISSION_META,
                }),
                400
            );
            return;
        }

        if (file && file.data.length > 0 && !detectImage(file.data)) {
            throw new HttpError(400, "Screenshot must be a PNG, JPEG or WebP image.");
        }

        // Count only fully validated tools, so a typo in the form never uses up
        // a network's allowance for genuine submissions.
        if (!rateLimit("submission:" + ctx.ip, 30, 3_600_000)) {
            const error = "This network has sent several tools already. Please try again later.";
            if (wantsJson(ctx)) throw new HttpError(429, error);
            ctx.htmlRaw(
                render("submission", {
                    received: false,
                    error,
                    values: fields,
                    meta: SUBMISSION_META,
                }),
                429
            );
            return;
        }

        const row = await withLock("submission-id", async () => {
            const id = await getNextSubmissionId();
            createToolBundle(
                {
                    id,
                    techname: d.techname,
                    link: d.link,
                    displaytext: d.displaytext,
                    tl1_desc: d.tl1_desc ?? "",
                    tl2_desc: d.tl2_desc ?? "",
                    tl3_desc: d.tl3_desc ?? "",
                    tl4_desc: d.tl4_desc ?? "",
                    tl5_desc: d.tl5_desc ?? "",
                    tl6_desc: d.tl6_desc ?? "",
                    tl5_tags: categorySelection(fields, "tl5"),
                    tl6_tags: categorySelection(fields, "tl6"),
                    username: d.username ?? "",
                    contact: d.contact ?? "",
                    accepted: false,
                },
                Object.fromEntries(flags) as unknown as Omit<CreateDomainInput, "id">,
                resourceResult.rows
            );
            return { id };
        });

        if (file && file.data.length > 0) saveUpload(row.id, file.data);

        sameSubmissionSuccess(ctx, row.id);
    });
}
