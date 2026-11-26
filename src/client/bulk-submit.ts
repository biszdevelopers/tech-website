/**
 * Browser-side CSV bulk submission. The CSV never leaves the browser as a file:
 * it is parsed here, previewed, then the parsed entries are POSTed as JSON.
 * Screenshots are selected separately and uploaded after the entries exist.
 */

interface ParsedRow {
    index: number;
    data: Record<string, string>;
    screenshot: string;
    categories: string;
    errors: string[];
}

const STRANDS = [
    "r",
    "tp",
    "mt",
    "ar",
    "u",
    "mdl",
    "ra",
    "rotech",
    "ls",
    "rothhink",
    "eost",
    "ef",
    "rte",
    "dloi",
    "raaoc",
];

const TL5_CATEGORIES = [
    "Self-reflection",
    "Growth goals",
    "Professional development",
    "Adaptability",
    "Ethical practice",
];

const TL6_CATEGORIES = [
    "Professional responsibilities",
    "Judgment and integrity",
    "Communication",
    "Collegiality",
];

let parsedRows: ParsedRow[] = [];
let schemaErrors: string[] = [];
const selectedImages: Record<string, File> = {};

function byId(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function csrf(): string {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
    return meta ? meta.content : "";
}

function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    const clean = text.replace(/^\uFEFF/, "");
    for (let index = 0; index < clean.length; index += 1) {
        const ch = clean.charAt(index);
        if (quoted) {
            if (ch === '"') {
                if (clean.charAt(index + 1) === '"') {
                    field += '"';
                    index += 1;
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

function normalizeHeader(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function isHttpUrl(value: string): boolean {
    return /^https?:\/\/[^\s]+$/i.test(value);
}

function truthy(value: string): boolean {
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "y";
}

function resourceLines(value: string): { error: string; count: number } {
    const lines = value.split(/\r?\n/);
    let count = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        const split = line.indexOf("|");
        if (split === -1) {
            return { error: `Resource ${index + 1} must use: Label | https://...`, count };
        }
        const label = line.slice(0, split).trim();
        const url = line.slice(split + 1).trim();
        if (!label) return { error: `Resource ${index + 1} needs a label.`, count };
        if (!isHttpUrl(url)) {
            return { error: `Resource ${index + 1} needs a valid http(s) URL.`, count };
        }
        count += 1;
    }
    return { error: "", count };
}

function categoriesError(value: string, allowed: string[]): string {
    if (!value.trim()) return "";
    const known: Record<string, boolean> = {};
    allowed.forEach((label) => {
        known[label.toLowerCase()] = true;
    });
    const unknown = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !known[part.toLowerCase()]);
    return unknown.length > 0
        ? `Unknown category: ${unknown.join(", ")}. Use: ${allowed.join(", ")}.`
        : "";
}

function readCell(row: string[], index: number): string {
    if (index < 0) return "";
    return String(row[index] === undefined ? "" : row[index]).trim();
}

function parseRows(text: string): void {
    parsedRows = [];
    schemaErrors = [];
    if (text.length > 2_000_000) {
        schemaErrors.push("CSV is too large (max 2 MB).");
        return;
    }
    const table = parseCsv(text);
    if (table.length === 0) return;
    const header = table[0].map(normalizeHeader);
    const col = (name: string): number => header.indexOf(name);
    const required = ["name", "link", "display"];
    required.forEach((name) => {
        if (col(name) === -1) schemaErrors.push(`Missing required column: ${name}`);
    });
    if (schemaErrors.length > 0) return;

    for (let index = 1; index < table.length; index += 1) {
        const row = table[index];
        if (row.every((cell) => !cell.trim())) continue;
        const data: Record<string, string> = {};
        const errors: string[] = [];
        const name = readCell(row, col("name"));
        const link = readCell(row, col("link"));
        const display = readCell(row, col("display"));
        if (!name) errors.push("Tool name is required.");
        if (!link || !isHttpUrl(link)) errors.push("A full http(s) link is required.");
        if (!display) errors.push("Display text is required.");
        data.techname = name;
        data.link = link;
        data.displaytext = display;
        (["tl1", "tl2", "tl3", "tl4", "tl5", "tl6"] as const).forEach((field) => {
            data[`${field}_desc`] =
                readCell(row, col(field)) || readCell(row, col(`${field}_description`));
        });
        let strandCount = 0;
        STRANDS.forEach((field) => {
            const active = truthy(readCell(row, col(field)));
            data[field] = active ? "true" : "";
            if (active) strandCount += 1;
        });
        const tl5Categories = readCell(row, col("tl5_categories"));
        const tl6Categories = readCell(row, col("tl6_categories"));
        const tl5Error = categoriesError(tl5Categories, TL5_CATEGORIES);
        const tl6Error = categoriesError(tl6Categories, TL6_CATEGORIES);
        if (tl5Error) errors.push(tl5Error);
        if (tl6Error) errors.push(tl6Error);
        if (strandCount === 0 && !data.tl5_desc && !data.tl6_desc) {
            errors.push("Choose at least one strand or add a TL5/TL6 write-up.");
        }
        data.resources = readCell(row, col("resources"));
        const resources = resourceLines(data.resources);
        if (resources.error) errors.push(resources.error);
        data.username = readCell(row, col("username"));
        data.contact = readCell(row, col("contact"));
        data.tl5_categories = tl5Categories;
        data.tl6_categories = tl6Categories;
        parsedRows.push({
            index,
            data,
            screenshot: readCell(row, col("screenshot")),
            categories: [tl5Categories, tl6Categories].filter(Boolean).join(" / "),
            errors,
        });
    }
    if (parsedRows.length > 30) {
        schemaErrors.push("Import at most 30 tools at a time.");
    }
}

function textElement(tag: string, text: string, className?: string): HTMLElement {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
}

function imageFor(name: string): File | null {
    if (!name) return null;
    return selectedImages[name.toLowerCase()] || null;
}

function renderPreview(): void {
    const summary = byId("bulk-summary");
    const errorsBox = byId("bulk-errors");
    const preview = byId("bulk-preview");
    const submit = byId("bulk-submit") as HTMLButtonElement | null;
    if (!summary || !errorsBox || !preview || !submit) return;
    summary.textContent = "";
    errorsBox.textContent = "";
    preview.textContent = "";

    schemaErrors.forEach((message) => {
        errorsBox.appendChild(textElement("p", message, "form-error"));
    });
    parsedRows.forEach((row) => {
        row.errors.forEach((message) => {
            errorsBox.appendChild(textElement("p", `Row ${row.index}: ${message}`, "form-error"));
        });
    });
    const rowErrors = parsedRows.reduce((total, row) => total + row.errors.length, 0);
    summary.textContent =
        parsedRows.length === 0
            ? "Choose a CSV file or paste CSV data to preview it."
            : `${parsedRows.length} ${parsedRows.length === 1 ? "tool" : "tools"} ready. ` +
              `${rowErrors} ${rowErrors === 1 ? "error" : "errors"}.`;
    if (parsedRows.length === 0) {
        submit.disabled = true;
        return;
    }

    const table = document.createElement("table");
    table.className = "bulk-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Row", "Name", "Strands", "Categories", "Resources", "Screenshot", "Status"].forEach(
        (label) => {
            headRow.appendChild(textElement("th", label));
        }
    );
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");

    parsedRows.forEach((row) => {
        const tr = document.createElement("tr");
        tr.appendChild(textElement("td", String(row.index)));
        tr.appendChild(textElement("td", row.data.techname || "-"));
        const strandCount = STRANDS.filter((field) => row.data[field] === "true").length;
        tr.appendChild(textElement("td", String(strandCount)));
        tr.appendChild(textElement("td", row.categories || "-"));
        const resourceCount = resourceLines(row.data.resources).count;
        tr.appendChild(textElement("td", String(resourceCount)));
        let shotText = "-";
        if (row.screenshot) shotText = imageFor(row.screenshot) ? "matched" : row.screenshot;
        tr.appendChild(textElement("td", shotText));
        const status = row.errors.length === 0 ? "Ready" : row.errors.join(" ");
        const statusCell = textElement(
            "td",
            status,
            row.errors.length === 0 ? "bulk-ok" : "bulk-bad"
        );
        tr.appendChild(statusCell);
        body.appendChild(tr);
    });
    table.appendChild(body);
    preview.appendChild(table);

    const blocked = schemaErrors.length > 0 || rowErrors > 0;
    submit.disabled = blocked;
}

function parseFromTextarea(): void {
    const textarea = byId("bulk-csv-text") as HTMLTextAreaElement | null;
    if (!textarea) return;
    parseRows(textarea.value);
    renderPreview();
}

function bindFileInput(): void {
    const input = byId("bulk-csv-file") as HTMLInputElement | null;
    const textarea = byId("bulk-csv-text") as HTMLTextAreaElement | null;
    if (!input || !textarea) return;
    input.addEventListener("change", function () {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
            textarea.value = String(reader.result || "");
            parseFromTextarea();
        };
        reader.onerror = function () {
            const errorsBox = byId("bulk-errors");
            if (errorsBox)
                errorsBox.appendChild(textElement("p", "Could not read that file.", "form-error"));
        };
        reader.readAsText(file);
    });
    textarea.addEventListener("input", parseFromTextarea);
}

function bindImages(): void {
    const input = byId("bulk-images") as HTMLInputElement | null;
    if (!input) return;
    input.addEventListener("change", function () {
        Object.keys(selectedImages).forEach((key) => {
            delete selectedImages[key];
        });
        const files = input.files;
        if (files) {
            Array.prototype.forEach.call(files, function (file: File) {
                selectedImages[file.name.toLowerCase()] = file;
            });
        }
        renderPreview();
    });
}

function postJson(
    url: string,
    body: unknown,
    onDone: (status: number, payload: Record<string, unknown> | null) => void
): void {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("x-csrf-token", csrf());
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        let payload: Record<string, unknown> | null;
        try {
            payload = JSON.parse(xhr.responseText || "{}") as Record<string, unknown>;
        } catch {
            payload = null;
        }
        onDone(xhr.status, payload);
    };
    xhr.send(JSON.stringify(body));
}

function uploadScreenshot(id: number, file: File, token: string, status: HTMLElement | null): void {
    const form = new FormData();
    form.append("_csrf", csrf());
    form.append("token", token);
    form.append("id", String(id));
    form.append("screenshot", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/submission/screenshot", true);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (status) {
            status.textContent =
                xhr.status >= 200 && xhr.status < 300
                    ? `Screenshot uploaded for ${file.name}.`
                    : `Screenshot failed for ${file.name} (HTTP ${xhr.status}).`;
        }
    };
    xhr.send(form);
}

function renderUploads(entries: Array<{ id: number; name: string }>, token: string): void {
    const box = byId("bulk-upload");
    if (!box) return;
    box.textContent = "";
    box.appendChild(textElement("h2", "Add screenshots"));
    box.appendChild(
        textElement(
            "p",
            "The entries are saved. Add a PNG, JPEG or WebP to any entry now, or ask an administrator to add one later.",
            "form-hint"
        )
    );
    entries.forEach((entry, index) => {
        const row = document.createElement("div");
        row.className = "bulk-upload-row";
        row.appendChild(textElement("span", entry.name, "bulk-upload-name"));
        const rowState = parsedRows[index];
        const matched = rowState ? imageFor(rowState.screenshot) : null;
        const status = textElement(
            "span",
            matched ? "Uploading..." : "No screenshot selected.",
            "bulk-upload-status"
        );
        row.appendChild(status);
        if (matched) {
            box.appendChild(row);
            uploadScreenshot(entry.id, matched, token, status);
            return;
        }
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/webp";
        input.addEventListener("change", function () {
            const file = input.files && input.files[0];
            if (!file) return;
            status.textContent = "Uploading...";
            uploadScreenshot(entry.id, file, token, status);
        });
        row.appendChild(input);
        box.appendChild(row);
    });
}

function bindSubmit(): void {
    const button = byId("bulk-submit") as HTMLButtonElement | null;
    const status = byId("bulk-status");
    if (!button || !status) return;
    button.addEventListener("click", function () {
        if (button.disabled) return;
        button.disabled = true;
        status.textContent = "Submitting entries...";
        postJson(
            "/api/submission/bulk",
            { entries: parsedRows.map((row) => row.data) },
            function (code, payload) {
                if (code >= 200 && code < 300 && payload) {
                    const entries = Array.isArray(payload.entries)
                        ? (payload.entries as Array<{ id: number; name: string }>)
                        : [];
                    const token = typeof payload.token === "string" ? payload.token : "";
                    status.textContent = `${entries.length} ${entries.length === 1 ? "tool is" : "tools are"} waiting for review.`;
                    renderUploads(entries, token);
                    return;
                }
                button.disabled = false;
                const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
                status.textContent =
                    (payload && typeof payload.error === "string" && payload.error) ||
                    `Submission failed (HTTP ${code}).`;
                if (errors.length > 0) {
                    const box = byId("bulk-errors");
                    if (box) {
                        box.textContent = "";
                        errors.forEach((message) => {
                            box.appendChild(textElement("p", String(message), "form-error"));
                        });
                    }
                }
            }
        );
    });
}

bindFileInput();
bindImages();
bindSubmit();
