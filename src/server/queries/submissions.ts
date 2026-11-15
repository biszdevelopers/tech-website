/**
 * ============================================================================
 * SUBMISSION & DOMAIN QUERIES (main database)
 * ============================================================================
 *
 * PURPOSE
 * All reads/writes for the public tech-tool directory live here, so route
 * handlers stay thin and every query has exactly one home.
 *
 * CACHING MODEL (changed from the previous framework - and simpler)
 * The old code wrapped these functions in Next.js unstable_cache with tag
 * invalidation. In v3 the finished PAGE is what gets cached (see
 * src/core/06-cache.ts + views/home.ts): SQLite answers these queries in
 * microseconds, so function-level caching added complexity without measurable
 * benefit. Writes still bust pageCache keys so visitors never see stale pages.
 *
 * LEARN: CACHE AT THE OUTPUT EDGE
 * Cache the most expensive, most shared artifact you have. For a read-heavy
 * directory site that is the rendered HTML, not intermediate row lists.
 * Measure before adding lower-level caches - you usually don't need them.
 */

import { mainDb } from "../../lib/db/main";
import { pageCache } from "../../core/06-cache";
import type { SubmissionRow, DomainRow } from "../../types/db";

/**
 * Data snapshot: pages read arrays/Maps, never the DB on a warm request.
 * Writes rebuild the snapshot once and bump the page-cache generation.
 */
let acceptedCache: SubmissionRow[] | null = null;
let allCache: SubmissionRow[] | null = null;
let domainCache: DomainRow[] | null = null;

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

function invalidateToolPages(): void {
    acceptedCache = null;
    allCache = null;
    domainCache = null;
    pageCache.bust(["home", "tl:*"]);
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

/**
 * Return only domain rows whose flagged columns include ALL requested strands.
 * The dataset is tiny (one row per tool), so filtering in memory keeps the
 * cache simple and stays far below any measurable cost.
 */
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

export interface CreateSubmissionInput {
    id: number;
    techname: string;
    link: string;
    displaytext: string;
    tl1_desc: string;
    tl2_desc: string;
    tl3_desc: string;
    tl4_desc: string;
    username: string;
    contact: string;
    accepted: boolean;
}

export async function createSubmission(data: CreateSubmissionInput): Promise<SubmissionRow> {
    const row = await mainDb.submission.create({ data });
    invalidateToolPages();
    return row;
}

export interface SubmissionUpdateInput {
    techname?: string;
    tl1_desc?: string;
    tl2_desc?: string;
    tl3_desc?: string;
    tl4_desc?: string;
    link?: string;
    displaytext?: string;
    accepted?: boolean;
    username?: string;
    contact?: string;
}

export async function updateSubmission(
    id: number,
    data: SubmissionUpdateInput
): Promise<SubmissionRow> {
    const row = await mainDb.submission.update({ where: { id }, data });
    invalidateToolPages();
    return row;
}

export async function acceptSubmission(id: number): Promise<SubmissionRow> {
    const row = await mainDb.submission.update({ where: { id }, data: { accepted: true } });
    invalidateToolPages();
    return row;
}

export async function rejectSubmission(id: number): Promise<SubmissionRow> {
    const row = await mainDb.submission.update({ where: { id }, data: { accepted: false } });
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
): Promise<DomainRow> {
    const row = await mainDb.domains.update({ where: { id }, data });
    invalidateToolPages();
    return row;
}

export async function deleteDomain(id: number): Promise<void> {
    await mainDb.domains.delete({ where: { id } });
    invalidateToolPages();
}

/**
 * IDs are assigned explicitly (max+1) rather than AUTOINCREMENT because
 * submission.id pairs 1:1 with domains.id and with /testuploads/<id>.png
 * filenames - a stable contract the original data model depends on.
 */
export async function getNextSubmissionId(): Promise<number> {
    const last = await mainDb.submission.findFirst({
        orderBy: { id: "desc" },
        select: { id: true },
    });
    return (last?.id ?? 0) + 1;
}
