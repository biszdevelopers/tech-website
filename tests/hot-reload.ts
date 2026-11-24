/**
 * HOT-RELOAD VERIFICATION (in-process, no server).
 * Proves that outside production, render() re-reads the template from disk on
 * every call - i.e., a saved .ejs edit is visible on the very next request.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadViews, render, setViewHelpers } from "../src/core/views";
import { tlList } from "../src/lib/tl-config";

const target = join(process.cwd(), "src", "views", "partials", "footer.ejs");
const original = readFileSync(target, "utf8");
const MARKER = "<!--HOTCHECK-->";
let failures = 0;

function expect(cond: boolean, label: string): void {
    console.log((cond ? "ok   " : "FAIL ") + label);
    if (!cond) failures++;
}

loadViews();
setViewHelpers({ tlList });
const cards = tlList.map((config) => ({
    id: config.id,
    href: `/${config.id}`,
    title: config.title,
    shortLabel: config.shortLabel,
    strands: config.strands.map((strand) => strand.label),
    items: config.strands.length ? config.strands.map((strand) => strand.label) : config.topics,
}));
const pageData = {
    cards,
    meta: {
        title: "Hot",
        description: "Hot",
        canonical: "https://example.test/",
        robots: "index",
        ogType: "website",
        image: "https://example.test/images/og-default.png",
        jsonLd: [],
    },
};

// 1. Baseline: marker absent.
expect(!render("home", pageData).includes(MARKER), "baseline render lacks marker");

// 2. Edit template ON DISK; no restart, no cache clear.
writeFileSync(target, MARKER + original);

// 3. Next render reflects the edit immediately.
expect(render("home", pageData).includes(MARKER), "edit visible on next render (hot)");

// 4. Restore.
writeFileSync(target, original);
expect(!render("home", pageData).includes(MARKER), "revert visible immediately");

if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
}
console.log("\nhot-reload contract satisfied.");
