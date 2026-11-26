/**
 * SEO primitives shared by routes, views and the generated crawler files.
 * No database imports here: every function is a pure transform of its input
 * plus the configured public origin, so tests and build helpers can use it.
 */

import { env } from "../config/env";
import { SITE } from "../config/site";
import { toolPath, toolPathById, type ToolIdentity } from "./tool-path";

export type JsonLdNode = Record<string, unknown>;
export type RobotsPolicy = "public" | "private";
export type OgType = "website" | "article";

/** Used when an OG image cannot be generated for this request. */
export const DEFAULT_OG_IMAGE = "/images/og-default.png";
export const OG_SITE_PATH = "/og/site.png";

export const ROBOTS_PUBLIC = "index, follow, max-image-preview:large";
export const ROBOTS_PRIVATE = "noindex, nofollow, noarchive";

export interface PageLink {
    name: string;
    /** Site-relative path or an absolute URL. */
    url: string;
}

export interface DomainSeoInput {
    id: string;
    title: string;
    description?: string;
    topics?: readonly string[];
}

export interface ToolSeoInput extends ToolIdentity {
    displaytext?: string;
    tl1_desc?: string;
    tl2_desc?: string;
    tl3_desc?: string;
    tl4_desc?: string;
    link?: string;
    /** Unix seconds, matching the main database. */
    updatedAt?: number;
}

export interface PageMetaInput {
    title: string;
    description?: string;
    /** Canonical path, normally without query parameters. */
    path: string;
    image?: string;
    ogType?: OgType;
    robots?: RobotsPolicy;
    jsonLd?: readonly JsonLdNode[];
}

export interface PageMeta {
    title: string;
    description: string;
    canonical: string;
    robots: string;
    ogType: OgType;
    image: string;
    jsonLd: JsonLdNode[];
}

export function absoluteUrl(path: string): string {
    if (!path) return `${env.siteOrigin}/`;
    if (/^https?:\/\//i.test(path)) return path;
    return `${env.siteOrigin}${path.startsWith("/") ? path : `/${path}`}`;
}

export function truncateDescription(text: string, max = 160): string {
    const clean = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    if (max <= 0) return "";
    if (clean.length <= max) return clean;
    if (max <= 3) return clean.slice(0, max);

    const cut = clean.slice(0, max - 3);
    const lastSpace = cut.lastIndexOf(" ");
    const base = lastSpace >= Math.floor((max - 3) * 0.6) ? cut.slice(0, lastSpace) : cut;
    return `${base.replace(/[\s,;:.-]+$/, "")}...`;
}

export function robotsFor(policy: RobotsPolicy = "public"): string {
    return policy === "private" ? ROBOTS_PRIVATE : ROBOTS_PUBLIC;
}

export function buildPageMeta(input: PageMetaInput): PageMeta {
    const title = input.title.trim();
    const image = input.image?.trim();
    return {
        title: title || SITE.name,
        description: truncateDescription(input.description?.trim() || SITE.description, 160),
        canonical: absoluteUrl(input.path),
        robots: robotsFor(input.robots),
        ogType: input.ogType ?? "website",
        image: absoluteUrl(image || DEFAULT_OG_IMAGE),
        jsonLd: [...(input.jsonLd ?? [])],
    };
}

export function ogSitePath(): string {
    return OG_SITE_PATH;
}

export function ogDomainPath(tl: string): string {
    return `/og/domain/${encodeURIComponent(tl)}.png`;
}

export function ogToolPath(tool: ToolIdentity): string;
export function ogToolPath(id: number, name: string): string;
export function ogToolPath(toolOrId: ToolIdentity | number, name = ""): string {
    const path = typeof toolOrId === "number" ? toolPathById(toolOrId, name) : toolPath(toolOrId);
    return `/og${path}.png`;
}

export function websiteLd(): JsonLdNode {
    return {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: SITE.name,
        alternateName: SITE.shortName,
        url: absoluteUrl("/"),
        description: SITE.description,
        inLanguage: "en",
        potentialAction: {
            "@type": "SearchAction",
            target: {
                "@type": "EntryPoint",
                urlTemplate: absoluteUrl("/search?query={search_term_string}"),
            },
            "query-input": "required name=search_term_string",
        },
    };
}

export function organizationLd(): JsonLdNode {
    return {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: SITE.name,
        url: absoluteUrl("/"),
        logo: {
            "@type": "ImageObject",
            url: absoluteUrl("/images/logo-icon.png"),
        },
        description: SITE.description,
    };
}

export function breadcrumbsLd(items: readonly PageLink[]): JsonLdNode {
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((item, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: item.name,
            item: absoluteUrl(item.url),
        })),
    };
}

export function collectionLd(
    name: string,
    description: string,
    url: string,
    items: readonly PageLink[],
    tools: readonly ToolIdentity[]
): JsonLdNode {
    const entries = [
        ...items.map((item) => ({ name: item.name, url: absoluteUrl(item.url) })),
        ...tools.map((tool) => ({
            name: tool.techname,
            url: absoluteUrl(toolPath(tool)),
        })),
    ];

    return {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name,
        description: truncateDescription(description, 300),
        url: absoluteUrl(url),
        inLanguage: "en",
        isPartOf: {
            "@type": "WebSite",
            name: SITE.name,
            url: absoluteUrl("/"),
        },
        mainEntity: {
            "@type": "ItemList",
            numberOfItems: entries.length,
            itemListElement: entries.map((entry, index) => ({
                "@type": "ListItem",
                position: index + 1,
                name: entry.name,
                url: entry.url,
            })),
        },
    };
}

export function toolLd(
    tool: ToolSeoInput,
    tlConfig: DomainSeoInput,
    imageUrl?: string
): JsonLdNode {
    const description =
        tool.tl1_desc ||
        tool.tl2_desc ||
        tool.tl3_desc ||
        tool.tl4_desc ||
        tool.displaytext ||
        `${tool.techname}, a technology tool for ${tlConfig.title}.`;
    const sameAs = /^https?:\/\//i.test(tool.link ?? "") ? tool.link : undefined;
    const dateModified = isoDate(tool.updatedAt);

    return {
        "@context": "https://schema.org",
        "@type": "LearningResource",
        name: tool.techname,
        description: truncateDescription(description, 300),
        url: absoluteUrl(toolPathById(tool.id, tool.techname)),
        image: absoluteUrl(imageUrl || ogToolPath(tool)),
        learningResourceType: "Teaching tool",
        inLanguage: "en",
        isPartOf: {
            "@type": "CollectionPage",
            name: tlConfig.title,
            url: absoluteUrl(`/${tlConfig.id}`),
        },
        provider: {
            "@type": "Organization",
            name: SITE.name,
            url: absoluteUrl("/"),
        },
        ...(tlConfig.topics?.length ? { keywords: tlConfig.topics.join(", ") } : {}),
        ...(sameAs ? { sameAs } : {}),
        ...(dateModified ? { dateModified } : {}),
    };
}

export function docsLd(): JsonLdNode {
    return {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: `${SITE.name} documentation`,
        name: "Project Docs",
        description: "How the site is built, where its code lives and how to run it.",
        url: absoluteUrl("/docs"),
        mainEntityOfPage: absoluteUrl("/docs"),
        inLanguage: "en",
        publisher: {
            "@type": "Organization",
            name: SITE.name,
            url: absoluteUrl("/"),
        },
    };
}

export function serializeJsonLd(value: unknown): string {
    return (JSON.stringify(value) ?? "null")
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

function isoDate(value?: number): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
