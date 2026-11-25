import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../../src/lib/rate-limit";

test("allows requests up to the limit", () => {
    const key = `unit-allow-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 5; i += 1) {
        assert.equal(rateLimit(key, 5, 60_000), true, `request ${i + 1}`);
    }
});

test("rejects requests over the limit", () => {
    const key = `unit-reject-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) rateLimit(key, 3, 60_000);
    assert.equal(rateLimit(key, 3, 60_000), false);
});

test("resets after the window", async () => {
    const key = `unit-reset-${Date.now()}-${Math.random()}`;
    assert.equal(rateLimit(key, 1, 20), true);
    assert.equal(rateLimit(key, 1, 20), false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(rateLimit(key, 1, 20), true);
});
