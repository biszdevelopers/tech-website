/**
 * Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF/LF).
 * Caps input and row count because imports are an authenticated but still
 * attacker-reachable path.
 */
export function parseCsv(text: string, maxRows = 10_000): string[][] {
    if (text.length > 2_000_000) throw new Error("CSV is too large (max 2 MB).");
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            quoted = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\n") {
            row.push(field.replace(/\r$/, ""));
            rows.push(row);
            if (rows.length > maxRows) throw new Error("Too many CSV rows.");
            row = [];
            field = "";
        } else {
            field += ch;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
    }
    return rows;
}

/** Neutralise spreadsheet formula injection (=, +, -, @, tab). */
export function csvCell(value: unknown): string {
    const raw = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
