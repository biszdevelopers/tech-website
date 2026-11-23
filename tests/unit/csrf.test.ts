import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { Context } from "../../src/core/03-context";
import { Context as ContextClass } from "../../src/core/03-context";
import { HttpError } from "../../src/core/09-errors";
import { isAllowedOrigin, normalizeOrigin } from "../../src/core/08-security";
import { readMultipart } from "../../src/lib/multipart";

const TOKEN = "a".repeat(64);

test("normalizeOrigin canonicalizes schemes, ports and trailing slashes", () => {
    assert.equal(normalizeOrigin("https://Example.com:443/"), "https://example.com");
    assert.equal(normalizeOrigin("http://example.com:80/path?q=1"), "http://example.com");
    assert.equal(normalizeOrigin("http://example.com:8080"), "http://example.com:8080");
    assert.equal(normalizeOrigin("not a url"), null);
    assert.equal(normalizeOrigin(undefined), null);
});

test("isAllowedOrigin accepts the canonical origin and the host actually hit", () => {
    assert.equal(isAllowedOrigin(undefined, null), true);
    assert.equal(isAllowedOrigin("http://localhost:3000", null), true);
    assert.equal(isAllowedOrigin("http://localhost:3000/", null), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:3000", "http://127.0.0.1:3000"), true);
    assert.equal(isAllowedOrigin("http://evil.example", "http://localhost:3000"), false);
    assert.equal(isAllowedOrigin("http://localhost:3001", "http://localhost:3000"), false);
    assert.equal(isAllowedOrigin("null", "http://localhost:3000"), false);
});

test("verifyCsrf rejects empty, short and mismatched tokens", () => {
    const ctx = Object.create(ContextClass.prototype) as Context;
    (ctx as unknown as { csrfToken: string }).csrfToken = TOKEN;
    assert.equal(ctx.verifyCsrf(TOKEN), true);
    assert.equal(ctx.verifyCsrf(""), false);
    assert.equal(ctx.verifyCsrf("a".repeat(32)), false);
    assert.equal(ctx.verifyCsrf("b".repeat(64)), false);

    const empty = Object.create(ContextClass.prototype) as Context;
    assert.equal(empty.verifyCsrf(""), false);
});

function multipartContext(token: string): Context {
    const boundary = "----test-boundary";
    const body = [
        `--${boundary}\r\nContent-Disposition: form-data; name="techname"\r\n\r\nTool\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${token}\r\n`,
        `--${boundary}--\r\n`,
    ].join("");
    const stream = Readable.from([Buffer.from(body)]) as Readable & {
        headers: Record<string, string>;
    };
    stream.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const ctx = Object.create(ContextClass.prototype) as Context;
    (ctx as unknown as { raw: Readable }).raw = stream;
    (ctx as unknown as { csrfToken: string }).csrfToken = TOKEN;
    return ctx;
}

test("multipart bodies are parsed once and must carry the CSRF token", async () => {
    const good = await readMultipart(multipartContext(TOKEN));
    assert.equal(good.fields.techname, "Tool");

    await assert.rejects(
        () => readMultipart(multipartContext("b".repeat(64))),
        (error: unknown) => error instanceof HttpError && error.status === 403
    );
});
