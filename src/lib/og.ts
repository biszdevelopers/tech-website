/**
 * Open Graph image generation. SVGs are rendered to PNG with sharp and cached
 * on disk; callers serve the returned path and never wait for the same image
 * twice.
 */

import { createHash } from "node:crypto";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { env } from "../config/env";
import { SITE } from "../config/site";
import { tlList } from "./tl-config";
import { toolSlug } from "./tool-path";

export { DEFAULT_OG_IMAGE } from "./seo";

const WIDTH = 1200;
const HEIGHT = 630;
const FONT = "Arial, Helvetica, sans-serif";
const OG_CACHE_DIR = resolve(process.env.OG_DIR?.trim() || "var/og");

/** Bump when the SVG layout changes so cached images are regenerated. */
const TEMPLATE_VERSION = "1";

const COLORS = {
    navy: "#071527",
    navyLight: "#0d2744",
    mint: "#5eead4",
    ink: "#f8fafc",
    muted: "#aec3d8",
    line: "#1e3a5f",
    chip: "#0f2a46",
} as const;

export interface DomainOgInput {
    tl: string;
    title: string;
    description: string;
}

export interface ToolOgInput {
    id: number;
    slug: string;
    name: string;
    description: string;
    domainLabel: string;
    updatedAt: number | string | Date;
}

export function escapeXml(value: string): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export function ogSiteFileName(version = ""): string {
    return `site-${shortHash(version)}.png`;
}

export function ogDomainFileName(tl: string, version = ""): string {
    return `domain/${safeSegment(tl, "domain")}-${shortHash(version)}.png`;
}

export function ogToolFileName(id: number, slug: string, version = ""): string {
    const toolId = safeId(id);
    return `tool/${toolId}/${safeSegment(slug, String(toolId))}-${shortHash(version)}.png`;
}

export async function generateSiteOg(): Promise<string> {
    const target = join(OG_CACHE_DIR, ogSiteFileName(siteVersion()));
    if (await fileExists(target)) return target;
    await writePng(siteSvg(), target);
    return target;
}

export async function generateDomainOg(input: DomainOgInput): Promise<string> {
    const title = cleanText(input.title) || input.tl.toUpperCase();
    const description = cleanText(input.description);
    const version = [TEMPLATE_VERSION, input.tl, title, description].join("|");
    const target = join(OG_CACHE_DIR, ogDomainFileName(input.tl, version));
    if (await fileExists(target)) return target;
    await writePng(domainSvg(input.tl, title, description), target);
    return target;
}

export async function generateToolOg(input: ToolOgInput): Promise<string> {
    const name = cleanText(input.name) || "Tech tool";
    const description = cleanText(input.description);
    const domainLabel = cleanText(input.domainLabel);
    const slug = input.slug || toolSlug(input.name, input.id);
    const version = [
        TEMPLATE_VERSION,
        String(safeId(input.id)),
        slug,
        name,
        description,
        domainLabel,
        String(input.updatedAt),
    ].join("|");
    const target = join(OG_CACHE_DIR, ogToolFileName(input.id, slug, version));
    if (await fileExists(target)) return target;
    await writePng(toolSvg(name, description, domainLabel), target);
    return target;
}

function siteSvg(): string {
    const subtitle = wrapText(SITE.description, 62, 2);
    const chips = tlList.map((config) => `${config.id.toUpperCase()} - ${config.shortLabel}`);
    const chipMarkup = chips
        .map((label, index) => {
            const x = 80 + (index % 3) * 360;
            const y = 402 + Math.floor(index / 3) * 78;
            return [
                `<rect x="${x}" y="${y}" width="320" height="60" rx="12" fill="${COLORS.chip}" stroke="${COLORS.line}" stroke-width="2"/>`,
                textLine(label, x + 160, y + 38, 21, COLORS.ink, 600, "middle"),
            ].join("");
        })
        .join("\n");

    return svgDocument(
        [
            kicker("TECH TOOLS DIRECTORY", 98),
            textLine(SITE.name, 80, 205, 82, COLORS.ink, 700),
            textBlock(subtitle, 80, 275, 40, 28, COLORS.muted),
            chipMarkup,
            footer(SITE.name, siteHost()),
        ].join("\n")
    );
}

function domainSvg(tl: string, title: string, description: string): string {
    const titleLines = wrapText(title, 29, 2);
    const descriptionLines = wrapText(description, 72, 3);
    const descriptionY = 210 + (titleLines.length - 1) * 78 + 76;

    return svgDocument(
        [
            kicker("TEACHING DOMAIN", 98),
            textLine(tl.toUpperCase(), 1120, 100, 24, COLORS.mint, 700, "end"),
            textBlock(titleLines, 80, 210, 78, 64, COLORS.ink, 700),
            textBlock(descriptionLines, 80, descriptionY, 42, 28, COLORS.muted),
            footer(SITE.name, siteHost()),
        ].join("\n")
    );
}

function toolSvg(name: string, description: string, domainLabel: string): string {
    const nameLines = wrapText(name, 23, 2);
    const descriptionLines = wrapText(description, 72, 3);
    const descriptionY = 210 + (nameLines.length - 1) * 86 + 76;

    return svgDocument(
        [
            kicker("TECH TOOL", 98),
            textLine(truncateLabel(domainLabel, 48), 1120, 100, 22, COLORS.mint, 600, "end"),
            textBlock(nameLines, 80, 210, 86, 74, COLORS.ink, 700),
            textBlock(descriptionLines, 80, descriptionY, 42, 28, COLORS.muted),
            footer(SITE.name, siteHost()),
        ].join("\n")
    );
}

function svgDocument(body: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${COLORS.navy}"/>
        <stop offset="1" stop-color="${COLORS.navyLight}"/>
    </linearGradient>
</defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
<circle cx="1080" cy="80" r="260" fill="${COLORS.mint}" opacity="0.08"/>
<circle cx="1080" cy="80" r="170" fill="none" stroke="${COLORS.mint}" stroke-width="2" opacity="0.22"/>
<rect x="0" y="0" width="14" height="${HEIGHT}" fill="${COLORS.mint}"/>
<rect x="80" y="578" width="1040" height="1" fill="${COLORS.line}"/>
${body}
</svg>`;
}

function kicker(text: string, y: number): string {
    return `<text x="80" y="${y}" font-family="${FONT}" font-size="22" font-weight="700" fill="${COLORS.mint}" letter-spacing="4">${escapeXml(text)}</text>`;
}

function textBlock(
    lines: readonly string[],
    x: number,
    y: number,
    lineHeight: number,
    size: number,
    fill: string,
    weight = 400
): string {
    return lines
        .map((line, index) => textLine(line, x, y + index * lineHeight, size, fill, weight))
        .join("\n");
}

function textLine(
    text: string,
    x: number,
    y: number,
    size: number,
    fill: string,
    weight = 400,
    anchor: "start" | "middle" | "end" = "start"
): string {
    const align = anchor === "start" ? "" : ` text-anchor="${anchor}"`;
    return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}"${align}>${escapeXml(text)}</text>`;
}

function footer(left: string, right: string): string {
    return [
        textLine(left, 80, 612, 20, COLORS.muted),
        textLine(right, 1120, 612, 20, COLORS.muted, 400, "end"),
    ].join("\n");
}

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
    const words = cleanText(text).split(" ").filter(Boolean);
    const lines: string[] = [];
    let current = "";
    let truncated = false;

    for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxChars) {
            current = candidate;
            continue;
        }
        if (current) {
            lines.push(current);
            current = "";
            if (lines.length >= maxLines) {
                truncated = true;
                break;
            }
            index -= 1;
            continue;
        }
        lines.push(word.slice(0, maxChars));
        if (lines.length >= maxLines) {
            truncated = index < words.length - 1 || word.length > maxChars;
            break;
        }
    }

    if (current && lines.length < maxLines) {
        lines.push(current);
    } else if (current) {
        truncated = true;
    }

    if (truncated && lines.length > 0) {
        const last = lines[lines.length - 1];
        lines[lines.length - 1] = `${last.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
    }
    return lines.slice(0, maxLines);
}

function cleanText(value: string): string {
    return String(value ?? "")
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function truncateLabel(value: string, max: number): string {
    const text = cleanText(value);
    return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function siteHost(): string {
    return env.siteOrigin.replace(/^https?:\/\//i, "");
}

async function writePng(svg: string, target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2)}.tmp`;
    try {
        await sharp(Buffer.from(svg, "utf8"))
            .timeout({ seconds: 15 })
            .png({ compressionLevel: 9 })
            .toFile(temp);
        await rename(temp, target);
    } catch (error) {
        await unlink(temp).catch(() => undefined);
        const reason = error instanceof Error ? error.message : String(error);
        const failure = new Error(`OG image generation failed: ${reason}`);
        (failure as Error & { cause?: unknown }).cause = error;
        throw failure;
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function siteVersion(): string {
    const domains = tlList.map((config) => `${config.id}:${config.shortLabel}`).join(",");
    return [TEMPLATE_VERSION, SITE.name, SITE.shortName, SITE.description, domains].join("|");
}

function safeSegment(value: string, fallback: string): string {
    const segment = String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/g, "");
    return segment || fallback;
}

function safeId(id: number): number {
    return Number.isFinite(id) && id > 0 ? Math.trunc(id) : 0;
}

function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
