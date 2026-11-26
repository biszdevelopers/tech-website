/**
 * MAIN SITE ROUTES - public pages, operator auth and submission intake.
 */
import { Application } from "../core/01-application";
import { Context } from "../core/03-context";
import { HttpError } from "../core/09-errors";
import { mainSessions } from "./guards";
import { render } from "../core/views";
import { loginSchema } from "../lib/validations/admin-auth";
import { submissionSchema, type SubmissionInput } from "../lib/validations/submission";
import { rateLimit, rateLimitBy } from "../lib/rate-limit";
import { readMultipart } from "../lib/multipart";
import { detectImage, saveUpload } from "../lib/uploads";
import { withLock } from "../lib/lock";
import { adminPasswordMatches, adminSessionVersion, adminUsernameMatches } from "../lib/admin-auth";
import { env } from "../config/env";
import { parseResourceLines } from "../lib/resources";
import {
    categoryLabels,
    categorySelection,
    splitCategories,
    type CategoryDomain,
} from "../lib/categories";
import { atLeastOneFlag, domainFlagsFromFields } from "../lib/domain-flags";
import { createBulkUploadToken, verifyBulkUploadToken } from "../lib/bulk-token";
import { strandColumnNames } from "../lib/tl-config";
import { mainDb } from "../lib/db/main";
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

const BULK_SUBMISSION_META = buildPageMeta({
    title: "Bulk Submit Tools | BIBS-C Tech Tools",
    description: "Import several teaching technology tools from a CSV file.",
    path: "/submission/import",
    robots: "private",
    jsonLd: [websiteLd()],
});

const BULK_MAX_ENTRIES = 30;
const SUBMISSION_LIMIT = 30;
const SUBMISSION_WINDOW_MS = 3_600_000;

interface PreparedBulkEntry {
    data: SubmissionInput;
    flags: Record<string, boolean>;
    resources: Array<{ label: string; url: string }>;
    tl5_tags: string;
    tl6_tags: string;
}

function bulkCategories(
    row: Record<string, unknown>,
    domain: CategoryDomain
): { value: string; error: string } {
    const labels = categoryLabels(domain);
    const allowed = new Map(labels.map((label) => [label.toLowerCase(), label]));
    const picked: string[] = [];
    const unknown: string[] = [];
    splitCategories(String(row[`${domain}_categories`] ?? "")).forEach((name) => {
        const canonical = allowed.get(name.toLowerCase());
        if (canonical) picked.push(canonical);
        else unknown.push(name);
    });
    if (unknown.length > 0) {
        return {
            value: "",
            error: `Unknown ${domain.toUpperCase()} category: ${unknown.join(", ")}. Use: ${labels.join(", ")}.`,
        };
    }
    return { value: picked.join(", "), error: "" };
}

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

    app.get("/submission/import", async (ctx) => {
        ctx.htmlRaw(render("submission-import", { meta: BULK_SUBMISSION_META }));
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

    app.post("/api/submission/bulk", async (ctx: Context) => {
        const body = await ctx.body();
        const rawEntries =
            body && typeof body === "object" ? (body as { entries?: unknown }).entries : undefined;
        if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
            throw new HttpError(400, "Add at least one CSV row.");
        }
        if (rawEntries.length > BULK_MAX_ENTRIES) {
            throw new HttpError(400, `Import at most ${BULK_MAX_ENTRIES} tools at a time.`);
        }

        const prepared: PreparedBulkEntry[] = [];
        const errors: string[] = [];
        rawEntries.forEach((raw, index) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                errors.push(`Row ${index + 1}: expected an object.`);
                return;
            }
            const row = raw as Record<string, unknown>;
            const parsed = submissionSchema.safeParse(row);
            if (!parsed.success) {
                errors.push(
                    `Row ${index + 1}: ${parsed.error.issues[0]?.message ?? "Validation failed."}`
                );
                return;
            }
            const data = parsed.data;
            const resources = parseResourceLines(data.resources ?? "");
            if (!resources.ok) {
                errors.push(`Row ${index + 1}: ${resources.error}`);
                return;
            }
            const flags = domainFlagsFromFields(row);
            const hasWriteup = Boolean(
                (data.tl5_desc ?? "").trim() || (data.tl6_desc ?? "").trim()
            );
            if (!atLeastOneFlag(flags) && !hasWriteup) {
                errors.push(
                    `Row ${index + 1}: choose at least one TL1-TL4 strand or add a TL5/TL6 write-up.`
                );
                return;
            }
            const tl5 = bulkCategories(row, "tl5");
            if (tl5.error) {
                errors.push(`Row ${index + 1}: ${tl5.error}`);
                return;
            }
            const tl6 = bulkCategories(row, "tl6");
            if (tl6.error) {
                errors.push(`Row ${index + 1}: ${tl6.error}`);
                return;
            }
            prepared.push({
                data,
                flags,
                resources: resources.rows,
                tl5_tags: tl5.value,
                tl6_tags: tl6.value,
            });
        });

        if (errors.length > 0) {
            ctx.json({ error: "Fix the CSV rows and try again.", errors }, 400);
            return;
        }

        if (
            !rateLimitBy(
                "submission:" + ctx.ip,
                prepared.length,
                SUBMISSION_LIMIT,
                SUBMISSION_WINDOW_MS
            )
        ) {
            ctx.json(
                {
                    error: "This network has sent several tools already. Please try again later.",
                },
                429
            );
            return;
        }

        const ids: number[] = [];
        await withLock("submission-id", async () => {
            for (const entry of prepared) {
                const id = await getNextSubmissionId();
                const data = entry.data;
                createToolBundle(
                    {
                        id,
                        techname: data.techname,
                        link: data.link,
                        displaytext: data.displaytext,
                        tl1_desc: data.tl1_desc ?? "",
                        tl2_desc: data.tl2_desc ?? "",
                        tl3_desc: data.tl3_desc ?? "",
                        tl4_desc: data.tl4_desc ?? "",
                        tl5_desc: data.tl5_desc ?? "",
                        tl6_desc: data.tl6_desc ?? "",
                        tl5_tags: entry.tl5_tags,
                        tl6_tags: entry.tl6_tags,
                        username: data.username ?? "",
                        contact: data.contact ?? "",
                        accepted: false,
                    },
                    entry.flags as unknown as Omit<CreateDomainInput, "id">,
                    entry.resources
                );
                ids.push(id);
            }
        });

        ctx.json({
            imported: ids.length,
            ids,
            token: createBulkUploadToken(ids),
            entries: prepared.map((entry, index) => ({
                id: ids[index],
                name: entry.data.techname,
            })),
        });
    });

    app.post("/api/submission/screenshot", async (ctx: Context) => {
        const { fields, file } = await readMultipart(ctx);
        const id = Number(fields.id);
        const token = String(fields.token ?? "");
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new HttpError(400, "Missing entry id.");
        }
        if (!verifyBulkUploadToken(token, id)) {
            throw new HttpError(403, "This upload link is invalid or expired.");
        }
        if (!rateLimit("submission-shot:" + ctx.ip, 60, SUBMISSION_WINDOW_MS)) {
            throw new HttpError(429, "Too many screenshot uploads. Try again later.");
        }
        if (!file || file.data.length === 0) {
            throw new HttpError(400, "Choose an image.");
        }
        if (!detectImage(file.data)) {
            throw new HttpError(400, "Screenshot must be a PNG, JPEG or WebP image.");
        }
        const row = await mainDb.submission.findUnique({ where: { id } });
        if (!row || row.accepted) {
            throw new HttpError(404, "Submission not found.");
        }
        saveUpload(id, file.data);
        ctx.json({ success: true });
    });
}
