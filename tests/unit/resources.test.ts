import { test } from "node:test";
import assert from "node:assert/strict";
import { formatResourceLines, parseResourceLines } from "../../src/lib/resources";

test("resources use Label | https://...", () => {
    const result = parseResourceLines(
        "Manual | https://example.com/guide\nVideo | https://example.com/watch"
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.rows, [
        { label: "Manual", url: "https://example.com/guide" },
        { label: "Video", url: "https://example.com/watch" },
    ]);
    assert.equal(
        formatResourceLines(result.rows),
        "Manual | https://example.com/guide\nVideo | https://example.com/watch"
    );
});

test("a resource without a label and pipe is rejected", () => {
    const result = parseResourceLines("https://example.com/guide");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Label \| https:\/\//);
});

test("a resource with a non-http URL is rejected", () => {
    const result = parseResourceLines("Manual | javascript:alert(1)");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /valid http\(s\) URL/);
});

test("duplicate resource URLs keep the first label", () => {
    const result = parseResourceLines(
        "First | https://example.com/a\nSecond | https://example.com/a"
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.rows, [{ label: "First", url: "https://example.com/a" }]);
});
