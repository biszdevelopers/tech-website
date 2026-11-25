/**
 * ADMIN ROUTES - pages, CSV, screenshots and the JSON mutation endpoints.
 */
import { Application } from "../core/01-application";
import { HttpError } from "../core/09-errors";
import { render } from "../core/views";
import { mainSessions } from "./guards";
import {
    getAllSubmissions,
    getAllDomains,
    getDomainById,
    getResources,
    getAllResources,
    createToolBundle,
    updateToolBundle,
    deleteToolBundle,
    getNextSubmissionId,
    acceptSubmission,
    rejectSubmission,
    type CreateDomainInput,
    type SubmissionUpdateInput,
} from "../server/queries/submissions";
import { readMultipart } from "../lib/multipart";
import { detectImage, deleteUpload, saveUpload, uploadExists } from "../lib/uploads";
import { parseCsv, csvCell } from "../lib/csv";
import { withLock } from "../lib/lock";
import { parseResourceLines, formatResourceLines } from "../lib/resources";
import { submissionSchema } from "../lib/validations/submission";
import { strandColumnNames, tlList, getTlConfig } from "../lib/tl-config";
import {
    categoryFieldName,
    categoryLabels,
    categorySelection,
    normalizeCategories,
    splitCategories,
} from "../lib/categories";
import { mainDb } from "../lib/db/main";

const DOMAIN_FIELDS = strandColumnNames();

const EDIT_STRANDS = tlList.flatMap((config) =>
    config.strands.map((strand) => ({ name: strand.domainColumn, label: strand.label }))
);

const DESCRIPTION_COLUMNS = tlList.map((config) => ({
    field: `${config.id}_desc`,
    label: config.title,
}));

type CategoryDomain = "tl5" | "tl6";

interface CategoryGroup {
    domain: CategoryDomain;
    title: string;
    options: Array<{ name: string; label: string; checked: boolean }>;
}

function categoryGroupsFor(tags: { tl5_tags?: string; tl6_tags?: string } = {}): CategoryGroup[] {
    return (["tl5", "tl6"] as const).map((domain) => {
        const selected = splitCategories(tags[`${domain}_tags`]);
        return {
            domain,
            title: getTlConfig(domain)?.title ?? domain,
            options: categoryLabels(domain).map((label, index) => ({
                name: categoryFieldName(domain, index),
                label,
                checked: selected.includes(label),
            })),
        };
    });
}

function domainDataFromFields(fields: Record<string, unknown>): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const field of DOMAIN_FIELDS) {
        const value = fields[field];
        flags[field] = value === true || value === "on" || value === "true" || value === "1";
    }
    return flags;
}

function atLeastOneFlag(flags: Record<string, boolean>): boolean {
    return Object.values(flags).some(Boolean);
}

function cell(row: string[], index: number): string {
    if (index < 0) return "";
    const value = String(row[index] ?? "");
    // Undo the spreadsheet-injection guard on a round-trip.
    return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

export function registerAdminRoutes(app: Application): void {
    app.get(
        "/admin",
        async (ctx) => {
            const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
            const status =
                ctx.query.get("status") === "accepted" || ctx.query.get("status") === "pending"
                    ? ctx.query.get("status")
                    : "all";
            let subs = await getAllSubmissions();
            if (q) {
                subs = subs.filter((s) =>
                    [
                        s.techname,
                        s.displaytext,
                        s.link,
                        s.username,
                        s.contact,
                        s.tl1_desc,
                        s.tl2_desc,
                        s.tl3_desc,
                        s.tl4_desc,
                        s.tl5_desc,
                        s.tl6_desc,
                    ]
                        .join(" ")
                        .toLowerCase()
                        .includes(q)
                );
            }
            if (status === "accepted") subs = subs.filter((s) => Boolean(s.accepted));
            if (status === "pending") subs = subs.filter((s) => !s.accepted);
            const total = subs.length;
            const perPage = 50;
            const pages = Math.max(1, Math.ceil(total / perPage));
            const requested = Math.floor(Number(ctx.query.get("page") ?? 1) || 1);
            const page = Math.min(Math.max(requested, 1), pages);
            subs = subs.slice((page - 1) * perPage, page * perPage);
            ctx.htmlRaw(
                render("admin", {
                    subs,
                    q,
                    status,
                    page,
                    pages,
                    total,
                    perPage,
                    descriptionColumns: DESCRIPTION_COLUMNS,
                })
            );
        },
        { guard: "mainAdmin" }
    );

    app.get(
        "/admin/edit/:id",
        async (ctx) => {
            const id = Number(ctx.params.id);
            if (!Number.isFinite(id)) ctx.throw(400, "Invalid id");
            const [sub, domain, resources] = await Promise.all([
                mainDb.submission.findUnique({ where: { id } }),
                getDomainById(id),
                getResources(id),
            ]);
            if (!sub) {
                ctx.throw(404, "Submission not found.");
                return;
            }
            const flags = (domain ?? {}) as unknown as Record<string, boolean>;
            const strands = EDIT_STRANDS.map(({ name, label }) => ({
                name,
                label,
                checked: flags[name] === true,
            }));
            ctx.htmlRaw(
                render("admin-edit", {
                    id,
                    sub,
                    strands,
                    categoryGroups: categoryGroupsFor(sub),
                    descriptionColumns: DESCRIPTION_COLUMNS,
                    resourceText: formatResourceLines(resources),
                    hasUpload: uploadExists(id),
                    saved: ctx.query.get("saved") === "1",
                })
            );
        },
        { guard: "mainAdmin" }
    );

    app.get(
        "/admin/export.csv",
        async (ctx) => {
            const [subs, domains, resources] = await Promise.all([
                getAllSubmissions(),
                getAllDomains(),
                getAllResources(),
            ]);
            const domainMap = new Map(domains.map((domain) => [domain.id, domain]));
            const resourceMap = new Map<number, string[]>();
            for (const resource of resources) {
                const list = resourceMap.get(resource.submissionId) ?? [];
                list.push(`${resource.label} | ${resource.url}`);
                resourceMap.set(resource.submissionId, list);
            }
            const domainCols = DOMAIN_FIELDS.map((field) => field.toLowerCase());
            const head = [
                "id",
                "name",
                "link",
                "display",
                "tl1",
                "tl2",
                "tl3",
                "tl4",
                "tl5",
                "tl6",
                "tl5_categories",
                "tl6_categories",
                "accepted",
                "username",
                "contact",
                "resources",
            ]
                .concat(domainCols)
                .join(",");
            const rows: string[] = [];
            for (const s of subs) {
                const domain = domainMap.get(s.id);
                const flags = DOMAIN_FIELDS.map((field) =>
                    domain
                        ? Number(Boolean((domain as unknown as Record<string, number>)[field]))
                        : 0
                );
                const resourcesText = (resourceMap.get(s.id) ?? []).join("\n");
                rows.push(
                    [
                        s.id,
                        s.techname,
                        s.link,
                        s.displaytext,
                        s.tl1_desc,
                        s.tl2_desc,
                        s.tl3_desc,
                        s.tl4_desc,
                        s.tl5_desc,
                        s.tl6_desc,
                        s.tl5_tags,
                        s.tl6_tags,
                        s.accepted ? 1 : 0,
                        s.username,
                        s.contact,
                        resourcesText,
                        ...flags,
                    ]
                        .map(csvCell)
                        .join(",")
                );
            }
            ctx.res.setHeader("Cache-Control", "private, no-store");
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
                    categoryGroups: categoryGroupsFor(),
                    descriptionColumns: DESCRIPTION_COLUMNS,
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
            const parsed = submissionSchema.safeParse(fields);
            if (!parsed.success) {
                throw new HttpError(400, parsed.error.issues[0]?.message ?? "Validation failed.");
            }
            const data = parsed.data;
            if (!isHttpUrl(data.link)) throw new HttpError(400, "Link must be http(s).");
            const resources = parseResourceLines(data.resources ?? "");
            if (!resources.ok) throw new HttpError(400, resources.error);
            const flags = domainDataFromFields(fields);
            if (
                !atLeastOneFlag(flags) &&
                !(data.tl5_desc ?? "").trim() &&
                !(data.tl6_desc ?? "").trim()
            ) {
                throw new HttpError(400, "Choose at least one strand or add a TL5/TL6 write-up.");
            }
            if (file && file.data.length > 0 && !detectImage(file.data)) {
                throw new HttpError(400, "Screenshot must be a PNG, JPEG or WebP image.");
            }
            const id = await withLock("submission-id", async () => {
                const next = await getNextSubmissionId();
                createToolBundle(
                    {
                        id: next,
                        techname: data.techname,
                        link: data.link,
                        displaytext: data.displaytext,
                        tl1_desc: data.tl1_desc ?? "",
                        tl2_desc: data.tl2_desc ?? "",
                        tl3_desc: data.tl3_desc ?? "",
                        tl4_desc: data.tl4_desc ?? "",
                        tl5_desc: data.tl5_desc ?? "",
                        tl6_desc: data.tl6_desc ?? "",
                        tl5_tags: categorySelection(fields, "tl5"),
                        tl6_tags: categorySelection(fields, "tl6"),
                        username: data.username ?? "",
                        contact: data.contact ?? "",
                        accepted: fields.accepted === "on" || fields.accepted === "true",
                    },
                    flags as unknown as Omit<CreateDomainInput, "id">,
                    resources.rows
                );
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
            if (rows.length < 2) {
                throw new HttpError(400, "CSV needs a header row and at least one data row.");
            }
            const header = rows[0].map((h) => h.trim().toLowerCase());
            const index = (name: string): number => header.indexOf(name);
            const required = ["name", "link", "display"];
            if (required.some((name) => index(name) === -1)) {
                throw new HttpError(400, "CSV header must include name, link and display.");
            }

            const existingSubs = await getAllSubmissions();
            const existingById = new Map(existingSubs.map((row) => [row.id, row]));
            const categoryColumn = (domain: "tl5" | "tl6"): number => {
                const primary = index(`${domain}_categories`);
                return primary >= 0 ? primary : index(`${domain}_tags`);
            };
            const tl5CategoryCol = categoryColumn("tl5");
            const tl6CategoryCol = categoryColumn("tl6");
            const existingDomains = await getAllDomains();
            const domainById = new Map(existingDomains.map((row) => [row.id, row]));
            const existingResources = await getAllResources();
            const resourcesById = new Map<number, Array<{ label: string; url: string }>>();
            for (const resource of existingResources) {
                const list = resourcesById.get(resource.submissionId) ?? [];
                list.push({ label: resource.label, url: resource.url });
                resourcesById.set(resource.submissionId, list);
            }

            let count = 0;
            const errors: string[] = [];
            await withLock("submission-id", async () => {
                for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
                    const row = rows[rowIndex];
                    if (row.every((value) => value.trim() === "")) continue;
                    const link = cell(row, index("link")).trim();
                    const name = cell(row, index("name")).trim();
                    const display = cell(row, index("display")).trim();
                    if (!name || !display || !isHttpUrl(link)) {
                        errors.push(
                            `Row ${rowIndex + 1}: name, display and a valid link are required.`
                        );
                        continue;
                    }
                    const existingId = index("id") >= 0 ? Number(row[index("id")]) : 0;
                    const existing = existingId > 0 ? existingById.get(existingId) : undefined;
                    const id = existing ? existingId : await getNextSubmissionId();

                    const updates: SubmissionUpdateInput = {};
                    if (index("name") >= 0) updates.techname = name;
                    if (index("link") >= 0) updates.link = link;
                    if (index("display") >= 0) updates.displaytext = display;
                    for (const column of DESCRIPTION_COLUMNS) {
                        if (index(column.field) >= 0) {
                            (updates as Record<string, string>)[column.field] = cell(
                                row,
                                index(column.field)
                            );
                        }
                    }
                    if (index("username") >= 0) updates.username = cell(row, index("username"));
                    if (index("contact") >= 0) updates.contact = cell(row, index("contact"));
                    if (tl5CategoryCol >= 0) {
                        updates.tl5_tags = normalizeCategories(cell(row, tl5CategoryCol), "tl5");
                    }
                    if (tl6CategoryCol >= 0) {
                        updates.tl6_tags = normalizeCategories(cell(row, tl6CategoryCol), "tl6");
                    }
                    if (index("accepted") >= 0) {
                        updates.accepted = cell(row, index("accepted")) === "1";
                    }

                    const current = existing ? domainById.get(id) : undefined;
                    const flags: Record<string, boolean> = {};
                    for (const field of DOMAIN_FIELDS) {
                        const col = index(field.toLowerCase());
                        if (col >= 0) {
                            flags[field] = cell(row, col) === "1";
                        } else if (current) {
                            flags[field] = Boolean(
                                (current as unknown as Record<string, number>)[field]
                            );
                        } else {
                            flags[field] = false;
                        }
                    }

                    let resources = resourcesById.get(id) ?? [];
                    if (index("resources") >= 0) {
                        const parsedResources = parseResourceLines(cell(row, index("resources")));
                        if (!parsedResources.ok) {
                            errors.push(`Row ${rowIndex + 1}: ${parsedResources.error}`);
                            continue;
                        }
                        resources = parsedResources.rows;
                    }
                    if (
                        !atLeastOneFlag(flags) &&
                        !cell(row, index("tl5")).trim() &&
                        !cell(row, index("tl6")).trim()
                    ) {
                        errors.push(
                            `Row ${rowIndex + 1}: choose at least one strand or add a TL5/TL6 write-up.`
                        );
                        continue;
                    }

                    if (existing) {
                        updateToolBundle(
                            id,
                            updates,
                            flags as unknown as Omit<CreateDomainInput, "id">,
                            resources
                        );
                    } else {
                        createToolBundle(
                            {
                                id,
                                techname: name,
                                link,
                                displaytext: display,
                                tl1_desc: cell(row, index("tl1")),
                                tl2_desc: cell(row, index("tl2")),
                                tl3_desc: cell(row, index("tl3")),
                                tl4_desc: cell(row, index("tl4")),
                                tl5_desc: cell(row, index("tl5")),
                                tl6_desc: cell(row, index("tl6")),
                                tl5_tags:
                                    tl5CategoryCol >= 0
                                        ? normalizeCategories(cell(row, tl5CategoryCol), "tl5")
                                        : "",
                                tl6_tags:
                                    tl6CategoryCol >= 0
                                        ? normalizeCategories(cell(row, tl6CategoryCol), "tl6")
                                        : "",
                                username: cell(row, index("username")),
                                contact: cell(row, index("contact")),
                                accepted: cell(row, index("accepted")) === "1",
                            },
                            flags as unknown as Omit<CreateDomainInput, "id">,
                            resources
                        );
                    }
                    count += 1;
                }
            });
            if (wantsJson(ctx)) {
                ctx.json({ success: `Imported ${count} rows.`, count, errors });
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
            const id = Number(fields.id);
            if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "Missing id.");
            if (!file || file.data.length === 0) throw new HttpError(400, "Choose an image.");
            const exists = await mainDb.submission.findUnique({ where: { id } });
            if (!exists) throw new HttpError(404, "Submission not found.");
            saveUpload(id, file.data);
            ctx.redirect("/admin/edit/" + id, 303);
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/accept",
        async (ctx) => {
            const body = await ctx.body();
            const payload = body && typeof body === "object" ? (body as { id?: unknown }) : {};
            const raw = String(payload.id ?? "");
            const ids = raw
                .split(",")
                .map(Number)
                .filter((id) => Number.isFinite(id) && id > 0);
            let changed = 0;
            for (const id of ids) if (await acceptSubmission(id)) changed += 1;
            if (changed === 0) throw new HttpError(404, "No matching submissions.");
            ctx.json({ success: true, changed });
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/reject",
        async (ctx) => {
            const body = await ctx.body();
            const payload = body && typeof body === "object" ? (body as { id?: unknown }) : {};
            const raw = String(payload.id ?? "");
            const ids = raw
                .split(",")
                .map(Number)
                .filter((id) => Number.isFinite(id) && id > 0);
            let changed = 0;
            for (const id of ids) if (await rejectSubmission(id)) changed += 1;
            if (changed === 0) throw new HttpError(404, "No matching submissions.");
            ctx.json({ success: true, changed });
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/delete",
        async (ctx) => {
            const body = await ctx.body();
            const payload = body && typeof body === "object" ? (body as { id?: unknown }) : {};
            const id = Number(payload.id);
            if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "Missing id.");
            const deleted = deleteToolBundle(id);
            if (!deleted) throw new HttpError(404, "Submission not found.");
            deleteUpload(id);
            ctx.json({ success: true });
        },
        { guard: "mainAdmin" }
    );

    app.post(
        "/api/admin/edit",
        async (ctx) => {
            const parsedBody = await ctx.body();
            const body =
                parsedBody && typeof parsedBody === "object"
                    ? (parsedBody as Record<string, unknown>)
                    : {};
            const id = Number(body.id1);
            if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "Missing id");
            const exists = await mainDb.submission.findUnique({ where: { id } });
            if (!exists) throw new HttpError(404, "Submission not found.");
            const parsed = submissionSchema.safeParse(body);
            if (!parsed.success) {
                throw new HttpError(400, parsed.error.issues[0]?.message ?? "Validation failed.");
            }
            const data = parsed.data;
            const resources = parseResourceLines(data.resources ?? "");
            if (!resources.ok) throw new HttpError(400, resources.error);
            const flags = domainDataFromFields(body);
            if (
                !atLeastOneFlag(flags) &&
                !(data.tl5_desc ?? "").trim() &&
                !(data.tl6_desc ?? "").trim()
            ) {
                throw new HttpError(400, "Choose at least one strand or add a TL5/TL6 write-up.");
            }
            updateToolBundle(
                id,
                {
                    techname: data.techname,
                    link: data.link,
                    displaytext: data.displaytext,
                    tl1_desc: data.tl1_desc ?? "",
                    tl2_desc: data.tl2_desc ?? "",
                    tl3_desc: data.tl3_desc ?? "",
                    tl4_desc: data.tl4_desc ?? "",
                    tl5_desc: data.tl5_desc ?? "",
                    tl6_desc: data.tl6_desc ?? "",
                    tl5_tags: categorySelection(body, "tl5"),
                    tl6_tags: categorySelection(body, "tl6"),
                    username: data.username ?? "",
                    contact: data.contact ?? "",
                },
                flags as unknown as Omit<CreateDomainInput, "id">,
                resources.rows
            );
            if (wantsJson(ctx)) {
                ctx.json({ success: true });
            } else {
                ctx.redirect("/admin/edit/" + id + "?saved=1", 303);
            }
        },
        { guard: "mainAdmin" }
    );
}

function wantsJson(ctx: { raw: { headers: Record<string, unknown> } }): boolean {
    return String(ctx.raw.headers.accept ?? "").includes("application/json");
}

export { mainSessions };
