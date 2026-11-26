/**
 * SUBMISSION AND DOMAIN QUERIES (main database)
 *
 * Reads are cached as arrays because the directory is small and read-heavy.
 * Writes rebuild the cache once. Page output is cached separately.
 */

import { mainDb, mainSqlite } from "../../lib/db/main";
import { pageCache } from "../../core/06-cache";
import type { SubmissionRow, DomainRow, ResourceRow } from "../../types/db";
import type { ResourceInput } from "../../lib/resources";
import { splitCategories } from "../../lib/categories";
import { toolPath } from "../../lib/tool-path";
import { strandColumnNames, tlList } from "../../lib/tl-config";

let acceptedCache: SubmissionRow[] | null = null;
let allCache: SubmissionRow[] | null = null;
let domainCache: DomainRow[] | null = null;
let resourceCache: ResourceRow[] | null = null;

export interface ToolView {
    id: number;
    techname: string;
    link: string;
    displaytext: string;
    tl1_desc: string;
    tl2_desc: string;
    tl3_desc: string;
    tl4_desc: string;
    tl5_desc: string;
    tl6_desc: string;
    tl5_tags: string;
    tl6_tags: string;
    accepted: boolean;
    username: string;
    contact: string;
    updatedAt: number;
    tags: Record<string, boolean>;
    tl5Categories: string[];
    tl6Categories: string[];
    mask: number;
    path: string;
    resources: ResourceRow[];
    searchText: string;
}

let toolViewCache: ToolView[] | null = null;
let toolViewById: Map<number, ToolView> | null = null;
const STRAND_COLUMNS = strandColumnNames();

/** Legacy rows may contain javascript:/data: links; never render those. */
function safeLink(value: unknown): string {
    try {
        const url = new URL(String(value ?? ""));
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "#";
    } catch {
        return "#";
    }
}

function sanitizeRows(rows: SubmissionRow[]): SubmissionRow[] {
    return rows.map((row) => ({ ...row, link: safeLink(row.link) }));
}

export function invalidateToolPages(): void {
    acceptedCache = null;
    allCache = null;
    domainCache = null;
    resourceCache = null;
    toolViewCache = null;
    toolViewById = null;
    pageCache.bust(["home", "tl:*", "tool:*"]);
}

export async function getAcceptedSubmissions(): Promise<SubmissionRow[]> {
    if (!acceptedCache) {
        acceptedCache = sanitizeRows(
            await mainDb.submission.findMany({
                where: { accepted: true },
                orderBy: { id: "asc" },
            })
        );
    }
    return acceptedCache;
}

export async function getAllSubmissions(): Promise<SubmissionRow[]> {
    if (!allCache) {
        allCache = sanitizeRows(await mainDb.submission.findMany({ orderBy: { id: "desc" } }));
    }
    return allCache;
}

export async function getAllDomains(): Promise<DomainRow[]> {
    if (!domainCache) domainCache = await mainDb.domains.findMany({ orderBy: { id: "asc" } });
    return domainCache;
}

export async function getAllResources(): Promise<ResourceRow[]> {
    if (!resourceCache) {
        resourceCache = (await mainDb.resources.findMany({
            orderBy: { sort: "asc" },
        })) as ResourceRow[];
    }
    return resourceCache;
}

export async function getResourcesFor(ids: number[]): Promise<Map<number, ResourceRow[]>> {
    const wanted = new Set(ids);
    const rows = (await getAllResources()).filter((row) => wanted.has(row.submissionId));
    const map = new Map<number, ResourceRow[]>();
    for (const row of rows) {
        const list = map.get(row.submissionId) ?? [];
        list.push(row);
        map.set(row.submissionId, list);
    }
    return map;
}

export async function getDomainsByColumns(columns: string[]): Promise<DomainRow[]> {
    const all = await getAllDomains();
    return all.filter((row) =>
        columns.some((c) => (row as unknown as Record<string, unknown>)[c] === true)
    );
}

export async function getSubmissionById(id: number): Promise<SubmissionRow | null> {
    const row = await mainDb.submission.findUnique({ where: { id } });
    return row ? { ...row, link: safeLink(row.link) } : null;
}

export async function getDomainById(id: number): Promise<DomainRow | null> {
    return mainDb.domains.findUnique({ where: { id } });
}

export async function getResources(id: number): Promise<ResourceRow[]> {
    return (await mainDb.resources.findMany({
        where: { submissionId: id },
        orderBy: { sort: "asc" },
    })) as ResourceRow[];
}

/**
 * Precomputed public tool model. Rebuilt only after a write; every storefront
 * read is then O(1) by id or O(K) after a tag lookup.
 */
export async function getAcceptedToolViews(): Promise<ToolView[]> {
    if (toolViewCache) return toolViewCache;
    const [subs, domains, resources] = await Promise.all([
        getAcceptedSubmissions(),
        getAllDomains(),
        getAllResources(),
    ]);
    const domainById = new Map(domains.map((row) => [row.id, row]));
    const resourcesById = new Map<number, ResourceRow[]>();
    for (const resource of resources) {
        const list = resourcesById.get(resource.submissionId) ?? [];
        list.push(resource);
        resourcesById.set(resource.submissionId, list);
    }
    toolViewCache = subs
        .filter((sub) => domainById.has(sub.id))
        .map((sub) => {
            const domain = domainById.get(sub.id) as unknown as Record<string, boolean>;
            const tags: Record<string, boolean> = {};
            let mask = 0;
            STRAND_COLUMNS.forEach((column, index) => {
                const active = domain[column] === true;
                tags[column] = active;
                if (active) mask |= 1 << index;
            });
            const searchText = tlList
                .map((config) => sub[`${config.id}_desc` as keyof SubmissionRow] ?? "")
                .concat([
                    sub.techname,
                    sub.displaytext,
                    sub.username,
                    sub.contact,
                    sub.tl5_tags,
                    sub.tl6_tags,
                ])
                .join(" ")
                .toLowerCase();
            return {
                ...sub,
                tags,
                tl5Categories: splitCategories(sub.tl5_tags),
                tl6Categories: splitCategories(sub.tl6_tags),
                mask,
                path: toolPath(sub),
                resources: resourcesById.get(sub.id) ?? [],
                searchText,
            };
        });
    toolViewById = new Map(toolViewCache.map((tool) => [tool.id, tool]));
    return toolViewCache;
}

export async function getToolViewById(id: number): Promise<ToolView | null> {
    await getAcceptedToolViews();
    return toolViewById?.get(id) ?? null;
}

export function getStrandMask(columns: string[]): number {
    let mask = 0;
    columns.forEach((column) => {
        const index = STRAND_COLUMNS.indexOf(column);
        if (index >= 0) mask |= 1 << index;
    });
    return mask;
}

export async function getToolsByMask(mask: number): Promise<ToolView[]> {
    const tools = await getAcceptedToolViews();
    if (mask === 0) return [];
    return tools.filter((tool) => (tool.mask & mask) !== 0);
}

export interface CreateSubmissionInput {
    id: number;
    techname: string;
    link: string;
    displaytext: string;
    tl1_desc: string;
    tl2_desc: string;
    tl3_desc: string;
    tl4_desc: string;
    tl5_desc: string;
    tl6_desc: string;
    tl5_tags: string;
    tl6_tags: string;
    username: string;
    contact: string;
    accepted: boolean;
    updatedAt?: number;
}

export async function createSubmission(data: CreateSubmissionInput): Promise<SubmissionRow> {
    const now = Math.floor(Date.now() / 1000);
    const row = await mainDb.submission.create({
        data: { ...data, updatedAt: data.updatedAt ?? now },
    });
    invalidateToolPages();
    return row;
}

export interface SubmissionUpdateInput {
    techname?: string;
    tl1_desc?: string;
    tl2_desc?: string;
    tl3_desc?: string;
    tl4_desc?: string;
    tl5_desc?: string;
    tl6_desc?: string;
    tl5_tags?: string;
    tl6_tags?: string;
    link?: string;
    displaytext?: string;
    accepted?: boolean;
    username?: string;
    contact?: string;
}

export async function updateSubmission(
    id: number,
    data: SubmissionUpdateInput
): Promise<SubmissionRow | null> {
    const row = await mainDb.submission.update({
        where: { id },
        data: { ...data, updatedAt: Math.floor(Date.now() / 1000) },
    });
    invalidateToolPages();
    return row;
}

export async function acceptSubmission(id: number): Promise<SubmissionRow | null> {
    const row = await mainDb.submission.update({
        where: { id },
        data: { accepted: true, updatedAt: Math.floor(Date.now() / 1000) },
    });
    invalidateToolPages();
    return row;
}

export async function rejectSubmission(id: number): Promise<SubmissionRow | null> {
    const row = await mainDb.submission.update({
        where: { id },
        data: { accepted: false, updatedAt: Math.floor(Date.now() / 1000) },
    });
    invalidateToolPages();
    return row;
}

export async function deleteSubmission(id: number): Promise<void> {
    await mainDb.submission.delete({ where: { id } });
    invalidateToolPages();
}

export interface CreateDomainInput {
    id: number;
    R: boolean;
    TP: boolean;
    MT: boolean;
    AR: boolean;
    U: boolean;
    MDL: boolean;
    RA: boolean;
    RoTech: boolean;
    LS: boolean;
    RoThink: boolean;
    EoST: boolean;
    EF: boolean;
    RTE: boolean;
    DLoI: boolean;
    RaAoC: boolean;
}

export async function createDomain(data: CreateDomainInput): Promise<DomainRow> {
    const row = await mainDb.domains.create({ data });
    invalidateToolPages();
    return row;
}

export async function updateDomain(
    id: number,
    data: Partial<Omit<CreateDomainInput, "id">>
): Promise<DomainRow | null> {
    const row = await mainDb.domains.update({ where: { id }, data });
    invalidateToolPages();
    return row;
}

export async function deleteDomain(id: number): Promise<void> {
    await mainDb.domains.delete({ where: { id } });
    invalidateToolPages();
}

const SUBMISSION_COLUMNS = [
    "id",
    "techname",
    "tl1_desc",
    "tl2_desc",
    "tl3_desc",
    "tl4_desc",
    "tl5_desc",
    "tl6_desc",
    "tl5_tags",
    "tl6_tags",
    "link",
    "displaytext",
    "accepted",
    "username",
    "contact",
    "updatedAt",
] as const;

const DOMAIN_COLUMNS = [
    "id",
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

type DomainFlags = Omit<CreateDomainInput, "id">;

/** Create submission, domain and resources in one SQLite transaction. */
function bindValue(value: unknown): string | number | bigint | Buffer | null {
    if (typeof value === "boolean") return value ? 1 : 0;
    return value as string | number | bigint | Buffer | null;
}

export function createToolBundle(
    data: CreateSubmissionInput,
    domain: DomainFlags,
    resources: ResourceInput[]
): void {
    const now = Math.floor(Date.now() / 1000);
    const values = {
        ...data,
        updatedAt: data.updatedAt ?? now,
    } as Record<string, unknown>;
    mainSqlite.transaction(() => {
        mainSqlite
            .prepare(
                `INSERT INTO submission (${SUBMISSION_COLUMNS.join(", ")}) VALUES (${SUBMISSION_COLUMNS.map(
                    () => "?"
                ).join(", ")})`
            )
            .run(...SUBMISSION_COLUMNS.map((column) => bindValue(values[column])));
        mainSqlite
            .prepare(
                `INSERT INTO domains (${DOMAIN_COLUMNS.join(", ")}) VALUES (${DOMAIN_COLUMNS.map(
                    () => "?"
                ).join(", ")})`
            )
            .run(
                ...DOMAIN_COLUMNS.map((column) =>
                    column === "id" ? data.id : Number(Boolean(domain[column]))
                )
            );
        const insert = mainSqlite.prepare(
            "INSERT INTO resources (submissionId, label, url, sort) VALUES (?, ?, ?, ?)"
        );
        resources.forEach((row, index) => insert.run(data.id, row.label, row.url, index));
    })();
    invalidateToolPages();
}

/** Update submission, upsert domain and replace resources atomically. */
export function updateToolBundle(
    id: number,
    data: SubmissionUpdateInput,
    domain: DomainFlags,
    resources: ResourceInput[]
): boolean {
    const allowed = SUBMISSION_COLUMNS.filter(
        (column) =>
            column !== "id" &&
            column !== "updatedAt" &&
            data[column as keyof SubmissionUpdateInput] !== undefined
    );
    let changed = 0;
    mainSqlite.transaction(() => {
        if (allowed.length > 0) {
            const result = mainSqlite
                .prepare(
                    `UPDATE submission SET ${allowed.map((column) => `${column} = ?`).join(", ")}, updatedAt = ? WHERE id = ?`
                )
                .run(
                    ...allowed.map((column) =>
                        bindValue(data[column as keyof SubmissionUpdateInput])
                    ),
                    Math.floor(Date.now() / 1000),
                    id
                );
            changed = result.changes;
        }
        mainSqlite
            .prepare(
                `INSERT INTO domains (${DOMAIN_COLUMNS.join(", ")}) VALUES (${DOMAIN_COLUMNS.map(
                    () => "?"
                ).join(", ")})
                 ON CONFLICT(id) DO UPDATE SET ${DOMAIN_COLUMNS.filter((column) => column !== "id")
                     .map((column) => `${column} = excluded.${column}`)
                     .join(", ")}`
            )
            .run(
                ...DOMAIN_COLUMNS.map((column) =>
                    column === "id" ? id : Number(Boolean(domain[column]))
                )
            );
        mainSqlite.prepare("DELETE FROM resources WHERE submissionId = ?").run(id);
        const insert = mainSqlite.prepare(
            "INSERT INTO resources (submissionId, label, url, sort) VALUES (?, ?, ?, ?)"
        );
        resources.forEach((row, index) => insert.run(id, row.label, row.url, index));
    })();
    invalidateToolPages();
    return changed > 0;
}

/** Delete the whole tool bundle atomically. */
export function deleteToolBundle(id: number): boolean {
    let changed = 0;
    mainSqlite.transaction(() => {
        mainSqlite.prepare("DELETE FROM resources WHERE submissionId = ?").run(id);
        mainSqlite.prepare("DELETE FROM domains WHERE id = ?").run(id);
        changed = mainSqlite.prepare("DELETE FROM submission WHERE id = ?").run(id).changes;
    })();
    invalidateToolPages();
    return changed > 0;
}

export function replaceResources(id: number, rows: ResourceInput[]): void {
    mainSqlite.transaction(() => {
        mainSqlite.prepare("DELETE FROM resources WHERE submissionId = ?").run(id);
        const insert = mainSqlite.prepare(
            "INSERT INTO resources (submissionId, label, url, sort) VALUES (?, ?, ?, ?)"
        );
        rows.forEach((row, index) => insert.run(id, row.label, row.url, index));
    })();
    invalidateToolPages();
}

/**
 * IDs are monotonic. The app_meta counter survives deletions so an upload file
 * can never be inherited by a future submission with the same number.
 */
export async function getNextSubmissionId(): Promise<number> {
    const meta = mainSqlite
        .prepare("SELECT value FROM app_meta WHERE key = 'nextSubmissionId'")
        .get() as { value?: string } | undefined;
    const maxRow = mainSqlite.prepare("SELECT MAX(id) AS id FROM submission").get() as {
        id?: number | null;
    };
    let next = Number(meta?.value);
    if (!Number.isSafeInteger(next) || next <= 0) next = Number(maxRow?.id ?? 0) + 1;
    if (next <= Number(maxRow?.id ?? 0)) next = Number(maxRow?.id ?? 0) + 1;
    mainSqlite
        .prepare(
            "INSERT INTO app_meta (key, value) VALUES ('nextSubmissionId', ?) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(String(next + 1));
    return next;
}
