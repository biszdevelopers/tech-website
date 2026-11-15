/**
 * ADMIN ROUTES - pages + the four JSON mutation endpoints.
 * Every route here requires the main-admin session (fail-closed).
 */

import { Application } from "../core/01-application";
import { HttpError } from "../core/09-errors";
import { mainSessions } from "./guards";
import { render } from "../core/views";
import {
    getAllSubmissions,
    getSubmissionById,
    getDomainById,
    acceptSubmission,
    rejectSubmission,
    deleteSubmission,
    deleteDomain,
    updateSubmission,
    updateDomain,
    createSubmission,
    createDomain,
    getNextSubmissionId,
} from "../server/queries/submissions";
import { readMultipart } from "../lib/multipart";
import { detectImage, deleteUpload, saveUpload } from "../lib/uploads";
import { parseCsv, csvCell } from "../lib/csv";
import { withLock } from "../lib/lock";

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

const DOMAIN_FIELDS = [
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
] as const;

/** Strand labels for the edit form use THEIR OWN casing - baseline verbatim. */
const EDIT_STRANDS: ReadonlyArray<{ name: string; label: string }> = [
    { name: "R", label: "Relationship" },
    { name: "TP", label: "Teacher Planning" },
    { name: "MT", label: "Modify Their Teaching" },
    { name: "AR", label: "Achieve Readiness" },
    { name: "U", label: "Understanding" },
    { name: "MDL", label: "Multi-Dimensional Learning" },
    { name: "RA", label: "Reasoned Arguments" },
    { name: "RoTech", label: "Repertoire of Techniques" },
    { name: "LS", label: "Learning Spaces" },
    { name: "RoThink", label: "Reflect on Thinking" },
    { name: "EoST", label: "Evidence of Student Learning" },
    { name: "EF", label: "Employ Feedback" },
    { name: "RTE", label: "Risk Taking Environment" },
    { name: "DLoI", label: "Deepening Lines of Inquiry" },
    { name: "RaAoC", label: "Responsibility and Aspects of Citizenship" },
];

export function registerAdminRoutes(app: Application): void {
    app.get(
        "/admin",
        async (ctx) => {
            const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
            const status =
                ctx.query.get("status") === "accepted" || ctx.query.get("status") === "pending"
                    ? ctx.query.get("status")
                    : "all";
            const page = Math.max(1, Number(ctx.query.get("page") ?? 1) || 1);
            const perPage = 50;
            let subs = await getAllSubmissions();
            if (q) {
                subs = subs.filter((s) =>
                    [s.techname, s.displaytext, s.link, s.username]
                        .join(" ")
                        .toLowerCase()
                        .includes(q)
                );
            }
            if (status === "accepted") subs = subs.filter((s) => Boolean(s.accepted));
            if (status === "pending") subs = subs.filter((s) => !s.accepted);
            const total = subs.length;
            subs = subs.slice((page - 1) * perPage, page * perPage);
            ctx.htmlRaw(render("admin", { subs, q, status, page, total, perPage }));
        },
        { guard: "mainAdmin" }
    );

    app.get(
        "/admin/edit/:id",
        async (ctx) => {
            const id = Number(ctx.params.id);
            if (!Number.isFinite(id)) ctx.throw(400, "Invalid id");
            const [sub, domain] = await Promise.all([getSubmissionById(id), getDomainById(id)]);
            if (sub === null) {
                ctx.throw(404, "Submission not found.");
                return; // unreachable - kept for null-flow narrowing
            }
            const flags = (domain ?? {}) as unknown as Record<string, boolean>;
            const strands = EDIT_STRANDS.map(({ name, label }) => ({
                name,
                label,
                checked: flags[name] === true,
            }));
            ctx.htmlRaw(
                render("admin-edit", { id, sub, strands, saved: ctx.query.get("saved") === "1" })
            );
        },
        { guard: "mainAdmin" }
    );

    app.get(
        "/admin/export.csv",
        async (ctx) => {
            // Spreadsheet-friendly dump of every submission (accepted flag
            // included). Quoting per RFC 4180 so commas/quotes survive Excel.
            const subs = await getAllSubmissions();
            const head = "id,name,link,display,tl1,tl2,tl3,tl4,accepted";
            const rows = subs.map((s) =>
                [
                    s.id,
                    s.techname,
                    s.link,
                    s.displaytext,
                    s.tl1_desc,
                    s.tl2_desc,
                    s.tl3_desc,
                    s.tl4_desc,
                    s.accepted ? 1 : 0,
                ]
                    .map(csvCell)
                    .join(",")
            );
            ctx.res.writeHead(200, {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": 'attachment; filename="submissions.csv"',
            });
            ctx.res.end([head, ...rows].join("\r\n"));
        },
        { guard: "mainAdmin" }
    );

    app.get(
        "/admin/new",
        async (ctx) => {
            ctx.htmlRaw(
                render("admin-new", {
                    strands: EDIT_STRANDS.map(({ name, label }) => ({
                        name,
                        label,
                        checked: false,
                    })),
                })
            );
        },
        { guard: "mainAdmin" }
    );

    app.get(
        "/admin/import",
        async (ctx) => {
            ctx.htmlRaw(render("admin-import", {}));
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/create",
        async (ctx) => {
            const { fields, file } = await readMultipart(ctx);
            if (fields._csrf !== ctx.csrfToken) throw new HttpError(403, "Invalid CSRF token");
            const techname = String(fields.techname ?? "").trim();
            const link = String(fields.link ?? "").trim();
            const displaytext = String(fields.displaytext ?? "").trim();
            if (!techname || !link || !displaytext) {
                throw new HttpError(400, "Tool name, link and display text are required.");
            }
            if (!isHttpUrl(link)) throw new HttpError(400, "Link must be http(s).");
            if (file && file.data.length > 0 && !detectImage(file.data)) {
                throw new HttpError(400, "Screenshot must be a PNG, JPEG or WebP image.");
            }
            const id = await withLock("submission-id", async () => {
                const next = await getNextSubmissionId();
                await createSubmission({
                    id: next,
                    techname,
                    link,
                    displaytext,
                    tl1_desc: String(fields.tl1_desc ?? ""),
                    tl2_desc: String(fields.tl2_desc ?? ""),
                    tl3_desc: String(fields.tl3_desc ?? ""),
                    tl4_desc: String(fields.tl4_desc ?? ""),
                    username: String(fields.username ?? ""),
                    contact: String(fields.contact ?? ""),
                    accepted: fields.accepted === "on" || fields.accepted === "true",
                });
                await createDomain(domainPayload(next, fields));
                return next;
            });
            if (file && file.data.length > 0) saveUpload(id, file.data);
            ctx.redirect("/admin", 303);
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/import",
        async (ctx) => {
            const form = await ctx.form();
            const text = String(form.csv ?? "");
            if (!text.trim()) throw new HttpError(400, "Paste CSV data first.");
            let rows: string[][];
            try {
                rows = parseCsv(text);
            } catch (error) {
                throw new HttpError(400, error instanceof Error ? error.message : "Invalid CSV.");
            }
            if (rows.length < 2)
                throw new HttpError(400, "CSV needs a header row and at least one data row.");
            const header = rows[0].map((h) => h.trim().toLowerCase());
            const index = (name: string): number => header.indexOf(name);
            const required = ["name", "link", "display"];
            if (required.some((name) => index(name) === -1)) {
                throw new HttpError(400, "CSV header must include name, link and display.");
            }
            let count = 0;
            await withLock("submission-id", async () => {
                for (const row of rows.slice(1)) {
                    if (row.every((cell) => cell.trim() === "")) continue;
                    const link = String(row[index("link")] ?? "").trim();
                    if (!isHttpUrl(link)) continue;
                    const existingId = index("id") >= 0 ? Number(row[index("id")]) : 0;
                    const data = {
                        techname: String(row[index("name")] ?? "").trim(),
                        link,
                        displaytext: String(row[index("display")] ?? "").trim(),
                        tl1_desc: cell(row, index("tl1")),
                        tl2_desc: cell(row, index("tl2")),
                        tl3_desc: cell(row, index("tl3")),
                        tl4_desc: cell(row, index("tl4")),
                    };
                    if (!data.techname || !data.displaytext) continue;
                    let id = existingId;
                    if (id > 0 && (await getSubmissionById(id))) {
                        await updateSubmission(id, data);
                    } else {
                        id = await getNextSubmissionId();
                        await createSubmission({
                            id,
                            ...data,
                            username: cell(row, index("username")),
                            contact: cell(row, index("contact")),
                            accepted: cell(row, index("accepted")) === "1",
                        });
                    }
                    const flags: Record<string, boolean> = {};
                    for (const field of DOMAIN_FIELDS) {
                        flags[field] = cell(row, index(field.toLowerCase())) === "1";
                    }
                    if (existingId > 0) {
                        await updateDomain(id, flags);
                    } else {
                        await createDomain({ id, ...flags } as Parameters<typeof createDomain>[0]);
                    }
                    count += 1;
                }
            });
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: `Imported ${count} rows.`, count });
            } else {
                ctx.redirect("/admin", 303);
            }
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/screenshot",
        async (ctx) => {
            const { fields, file } = await readMultipart(ctx);
            if (fields._csrf !== ctx.csrfToken) throw new HttpError(403, "Invalid CSRF token");
            const id = Number(fields.id);
            if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "Missing id.");
            if (!file || file.data.length === 0) throw new HttpError(400, "Choose an image.");
            saveUpload(id, file.data);
            ctx.redirect("/admin/edit/" + id, 303);
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/accept",
        async (ctx) => {
            const body = await ctx.body();
            // Bulk form: ids arrive as "1,2,3" from the checkbox batch; the
            // single-row JS path still sends one plain id.
            const raw = String((body as { id?: unknown }).id ?? "");
            const ids = raw.split(",").map(Number).filter(Number.isFinite);
            for (const id of ids) await acceptSubmission(id);
            ctx.json({ success: true });
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/reject",
        async (ctx) => {
            const body = await ctx.body();
            const raw = String((body as { id?: unknown }).id ?? "");
            const ids = raw.split(",").map(Number).filter(Number.isFinite);
            for (const id of ids) await rejectSubmission(id);
            ctx.json({ success: true });
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/delete",
        async (ctx) => {
            const body = await ctx.body();
            const id = Number((body as { id?: unknown }).id);
            await deleteDomain(id); // legacy deleted both rows together
            await deleteSubmission(id);
            deleteUpload(id);
            ctx.json({ success: true });
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/edit",
        async (ctx) => {
            const body = (await ctx.body()) as Record<string, unknown>;
            const id = Number(body.id1);
            if (!id) throw new HttpError(400, "Missing id");
            const link = String(body.Link ?? "");
            if (!isHttpUrl(link)) throw new HttpError(400, "Link must be http(s).");

            await updateSubmission(id, {
                techname: String(body.Techname ?? ""),
                link,
                displaytext: String(body.display ?? ""),
                tl1_desc: String(body.description ?? ""),
                tl2_desc: String(body.description2 ?? ""),
                tl3_desc: String(body.description3 ?? ""),
                tl4_desc: String(body.description4 ?? ""),
            });

            // Checkbox fields arrive as true/'on'/1 from the form encoder.
            const domainData: Record<string, boolean> = {};
            for (const field of DOMAIN_FIELDS) {
                const v = body[field];
                domainData[field] = v === true || v === "on" || v === 1 || v === "true";
            }
            await updateDomain(id, domainData);
            if (String(ctx.raw.headers.accept ?? "").includes("application/json")) {
                ctx.json({ success: true });
            } else {
                ctx.redirect("/admin/edit/" + id + "?saved=1", 303);
            }
        },
        { guard: "mainAdmin" }
    );
}

function cell(row: string[], index: number): string {
    return index >= 0 ? String(row[index] ?? "") : "";
}

function domainPayload(
    id: number,
    fields: Record<string, string>
): Parameters<typeof createDomain>[0] {
    const flags: Record<string, boolean> = {};
    for (const field of DOMAIN_FIELDS) {
        flags[field] = fields[field] === "on" || fields[field] === "true" || fields[field] === "1";
    }
    return { id, ...flags } as Parameters<typeof createDomain>[0];
}

// Re-exported so server.ts can build a login-aware logout link set later.
export { mainSessions };
