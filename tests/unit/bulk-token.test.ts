import { test } from "node:test";
import assert from "node:assert/strict";
import { createBulkUploadToken, verifyBulkUploadToken } from "../../src/lib/bulk-token";

test("bulk upload token authorizes only its own entries", () => {
    const token = createBulkUploadToken([10, 11, 12]);
    assert.equal(verifyBulkUploadToken(token, 10), true);
    assert.equal(verifyBulkUploadToken(token, 12), true);
    assert.equal(verifyBulkUploadToken(token, 13), false);
});

test("bulk upload token rejects tampering and expiry", () => {
    const token = createBulkUploadToken([10]);
    const [payload, signature] = token.split(".");
    assert.equal(verifyBulkUploadToken(`${payload}.${"0".repeat(64)}`, 10), false);
    const tampered = payload.replace(/^\d+/, "1");
    assert.equal(verifyBulkUploadToken(`${tampered}.${signature}`, 10), false);
    assert.equal(verifyBulkUploadToken(token, 10, Date.now() + 2 * 60 * 60 * 1000), false);
});
