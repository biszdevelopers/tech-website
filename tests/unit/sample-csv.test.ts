import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsv } from "../../src/lib/csv";
import { parseResourceLines } from "../../src/lib/resources";

const rows = parseCsv(readFileSync("public/sample-submissions.csv", "utf8"));
const header = rows[0].map((cell) => cell.trim());
const index = (name: string): number => header.indexOf(name);

test("sample CSV has the documented headers", () => {
    [
        "name",
        "link",
        "display",
        "tl5_categories",
        "tl6_categories",
        "resources",
        "screenshot",
    ].forEach((name) => assert.notEqual(index(name), -1, `missing ${name}`));
});

test("every sample row has the full column count", () => {
    rows.slice(1).forEach((row, position) => {
        assert.equal(row.length, header.length, `row ${position + 2}`);
    });
});

test("sample rows are valid bulk submissions", () => {
    rows.slice(1).forEach((row, position) => {
        assert.ok(row[index("name")].trim(), `row ${position + 2} name`);
        assert.match(row[index("link")].trim(), /^https?:\/\//, `row ${position + 2} link`);
        assert.ok(row[index("display")].trim(), `row ${position + 2} display`);
        const resources = parseResourceLines(row[index("resources")] ?? "");
        assert.equal(resources.ok, true, `row ${position + 2} resources`);
    });
});
