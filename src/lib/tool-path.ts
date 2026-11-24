/**
 * Tool URL helpers. One slug algorithm shared by routing, sitemap links, OG
 * images and canonical URLs keeps old and new links pointing at the same page.
 */

export interface ToolIdentity {
    id: number;
    techname: string;
}

/** Latin letters that Unicode NFD does not split into base + combining mark. */
const TRANSLITERATE: Record<string, string> = {
    "\u00df": "ss",
    "\u00e6": "ae",
    "\u0153": "oe",
    "\u00f8": "o",
    "\u0142": "l",
    "\u0111": "d",
    "\u00f0": "d",
    "\u00fe": "th",
    "\u0131": "i",
};

const SLUG_MAX = 60;

export function toolSlug(name: string, id: number): string {
    const slug = String(name ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\x20-\x7e]/g, (ch) => TRANSLITERATE[ch] ?? ch)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, SLUG_MAX)
        .replace(/-+$/g, "");

    return slug || String(id);
}

export function toolPath(tool: ToolIdentity): string {
    return `/tool/${tool.id}/${toolSlug(tool.techname, tool.id)}`;
}

export function toolPathById(id: number, name: string): string {
    return `/tool/${id}/${toolSlug(name, id)}`;
}
