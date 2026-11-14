import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "../core/03-context";
import { HttpError } from "../core/09-errors";
import { env } from "../config/env";

const MAX_BYTES = 5_000_000;

export interface DetectedImage {
    ext: "png" | "jpg" | "webp";
    mime: string;
}

/** Trust bytes, not the client-supplied filename or Content-Type. */
export function detectImage(data: Buffer): DetectedImage | null {
    if (data.length < 12 || data.length > MAX_BYTES) return null;
    if (
        data[0] === 0x89 &&
        data[1] === 0x50 &&
        data[2] === 0x4e &&
        data[3] === 0x47 &&
        data[4] === 0x0d &&
        data[5] === 0x0a &&
        data[6] === 0x1a &&
        data[7] === 0x0a
    ) {
        return { ext: "png", mime: "image/png" };
    }
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return { ext: "jpg", mime: "image/jpeg" };
    }
    if (
        data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WEBP"
    ) {
        return { ext: "webp", mime: "image/webp" };
    }
    return null;
}

function root(): string {
    return resolve(process.cwd(), env.uploadsDir);
}

function ensureRoot(): string {
    const dir = root();
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Write `<id>.<ext>`; returns the public URL. Old extension variants are removed. */
export function saveUpload(id: number, data: Buffer): string {
    const image = detectImage(data);
    if (!image) throw new HttpError(400, "Screenshot must be a PNG, JPEG or WebP image.");
    const dir = ensureRoot();
    for (const ext of ["png", "jpg", "webp"] as const) {
        const stale = join(dir, `${id}.${ext}`);
        if (ext !== image.ext && existsSync(stale)) unlinkSync(stale);
    }
    writeFileSync(join(dir, `${id}.${image.ext}`), data);
    invalidateUploadCache(id);
    return `/uploads/${id}`;
}

export function deleteUpload(id: number): void {
    const dir = root();
    for (const ext of ["png", "jpg", "webp"] as const) {
        const file = join(dir, `${id}.${ext}`);
        if (existsSync(file)) unlinkSync(file);
    }
    invalidateUploadCache(id);
}

interface UploadFile {
    path: string;
    mime: string;
}

const cache = new Map<string, UploadFile | null>();

function locate(id: number): UploadFile | null {
    const key = String(id);
    if (cache.has(key)) return cache.get(key)!;
    let found: UploadFile | null = null;
    const dir = root();
    for (const ext of ["png", "jpg", "webp"] as const) {
        const path = join(dir, `${id}.${ext}`);
        if (existsSync(path)) {
            found = { path, mime: ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp" };
            break;
        }
    }
    if (!found) {
        // Seeded screenshots live in the build tree; keep the legacy URL working.
        const legacy = resolve(process.cwd(), "dist/public/testuploads", `${id}.png`);
        if (legacy.startsWith(resolve(process.cwd(), "dist/public"))) {
            if (existsSync(legacy)) found = { path: legacy, mime: "image/png" };
        }
    }
    if (cache.size > 2048) cache.clear();
    cache.set(key, found);
    return found;
}

export function invalidateUploadCache(id: number): void {
    cache.delete(String(id));
}

/** GET /uploads/:file - safe image-only handler with immutable caching. */
export function serveUpload(ctx: Context, file: string): boolean {
    const match = /^(\d+)(?:\.(?:png|jpe?g|webp))?$/i.exec(file);
    if (!match) return false;
    const id = Number(match[1]);
    if (!Number.isFinite(id)) return false;
    const found = locate(id);
    if (!found) return false;
    const stat = statSync(found.path);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    ctx.res.setHeader("Content-Type", found.mime);
    ctx.res.setHeader("X-Content-Type-Options", "nosniff");
    ctx.res.setHeader("Content-Disposition", "inline");
    // Screenshots can be replaced under the same id, so not immutable.
    ctx.res.setHeader("Cache-Control", "public, max-age=3600");
    ctx.res.setHeader("Content-Length", stat.size);
    ctx.res.setHeader("ETag", etag);
    if (ctx.raw.headers["if-none-match"] === etag) {
        ctx.res.statusCode = 304;
        ctx.res.end();
        return true;
    }
    if (ctx.method === "HEAD") {
        ctx.res.end();
        return true;
    }
    ctx.res.end(readFileSync(found.path));
    return true;
}

export function uploadExists(id: number): boolean {
    return locate(id) !== null;
}

/** Used by tests: content hash of an upload, or null. */
export function uploadDigest(id: number): string | null {
    const found = locate(id);
    return found ? createHash("sha256").update(readFileSync(found.path)).digest("hex") : null;
}
