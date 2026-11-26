export interface ResourceInput {
    label: string;
    url: string;
}

export type ResourceParseResult =
    { ok: true; rows: ResourceInput[] } | { ok: false; error: string };

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

export function parseResourceLines(text: string): ResourceParseResult {
    const rows: ResourceInput[] = [];
    const seen = new Set<string>();
    for (const raw of String(text ?? "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const split = line.indexOf("|");
        if (split === -1) {
            return { ok: false, error: "Each resource must use: Label | https://..." };
        }
        const label = line.slice(0, split).trim();
        const url = line.slice(split + 1).trim();
        if (!label || label.length > 80) {
            return { ok: false, error: "Every resource needs a label of 1-80 characters." };
        }
        if (!url || url.length > 2048 || !isHttpUrl(url)) {
            return { ok: false, error: "Every resource needs a valid http(s) URL." };
        }
        if (seen.has(url)) continue;
        seen.add(url);
        rows.push({ label, url });
        if (rows.length > 10) return { ok: false, error: "A tool can have at most 10 resources." };
    }
    return { ok: true, rows };
}

export function formatResourceLines(rows: Array<{ label: string; url: string }>): string {
    return rows.map((row) => `${row.label} | ${row.url}`).join("\n");
}
