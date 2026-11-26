import { getTlConfig } from "./tl-config";

export type CategoryDomain = "tl5" | "tl6";

export const categoryDomains: CategoryDomain[] = ["tl5", "tl6"];

export function categoryLabels(domain: CategoryDomain): string[] {
    return getTlConfig(domain)?.topics ?? [];
}

export function categoryFieldName(domain: CategoryDomain, index: number): string {
    return `${domain}_c${index + 1}`;
}

export function categoryFilterName(domain: CategoryDomain, index: number): string {
    return `cat_${domain}_${index + 1}`;
}

/** Kept so old links written before the TL5/TL6 split still filter the page. */
export function legacyCategoryFilterName(index: number): string {
    return `cat_${index + 1}`;
}

/** Turn checked category boxes into the stored, comma-separated value. */
export function categorySelection(fields: Record<string, unknown>, domain: CategoryDomain): string {
    return categoryLabels(domain)
        .filter((_, index) => {
            const value = fields[categoryFieldName(domain, index)];
            return value === "true" || value === "1" || value === "on";
        })
        .join(", ");
}

export function splitCategories(value: string | null | undefined): string[] {
    return String(value ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
}

/** Keep CSV and form input inside the configured category list. */
export function normalizeCategories(value: string, domain: CategoryDomain): string {
    const allowed = new Set(categoryLabels(domain));
    return splitCategories(value)
        .filter((label) => allowed.has(label))
        .join(", ");
}
