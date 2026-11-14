import { test } from "node:test";
import assert from "node:assert/strict";
import { detectImage } from "../../src/lib/uploads";
import { assertPublicTarget, buildAttackUrl, assertAllowedMethod } from "../../src/lib/targets";
import { parseCsv, csvCell } from "../../src/lib/csv";
import { verifyPassword } from "../../src/lib/passwords";
import { randomBytes, scryptSync } from "node:crypto";

test("uploads: accepts real PNG/JPEG/WebP signatures only", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    assert.equal(detectImage(png)?.ext, "png");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(detectImage(jpeg)?.ext, "jpg");
    const webp = Buffer.from("RIFF0000WEBP0000", "ascii");
    assert.equal(detectImage(webp)?.ext, "webp");
    assert.equal(detectImage(Buffer.from("<html><script>", "utf8")), null);
});

test("targets: literal private addresses are refused", async () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "192.168.1.4", "169.254.169.254", "::1", "localhost"]) {
        await assert.rejects(assertPublicTarget(host));
    }
    assert.equal(await assertPublicTarget("1.1.1.1"), "1.1.1.1");
});

test("targets: URL template cannot change origin", () => {
    const url = buildAttackUrl("https://api.example.test/attack?host=[host]&port=[port]", {
        host: "1.1.1.1",
        port: "80",
        time: "10",
        method: "UDP",
    });
    assert.equal(new URL(url).origin, "https://api.example.test");
    const encoded = buildAttackUrl("https://api.example.test/attack?host=[host]", {
        host: "evil.test#fragment",
        port: "80",
        time: "10",
        method: "UDP",
    });
    assert.equal(new URL(encoded).origin, "https://api.example.test");
    assert.equal(new URL(encoded).hash, "");
    assert.throws(() => assertAllowedMethod("NOPE", ["UDP"]));
});

test("passwords: legacy scrypt hashes verify and upgrade", async () => {
    const salt = randomBytes(16).toString("hex");
    const legacy = `${salt}:${scryptSync("secret-pass", salt, 64).toString("hex")}`;
    const check = await verifyPassword("secret-pass", legacy);
    assert.equal(check.ok, true);
    assert.ok(check.rehashed?.startsWith("$2"));
    assert.equal((await verifyPassword("wrong", legacy)).ok, false);
});

test("csv: quoted fields and formula neutralising", () => {
    const rows = parseCsv('name,link,display\n"Tool, One",https://x.test,"=cmd"\n');
    assert.deepEqual(rows[0], ["name", "link", "display"]);
    assert.deepEqual(rows[1], ["Tool, One", "https://x.test", "=cmd"]);
    assert.equal(csvCell("=cmd"), "'=cmd");
    assert.equal(csvCell('a"b'), '"a""b"');
});
