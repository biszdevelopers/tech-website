import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { Context } from "../../src/core/03-context";
import { Context as ContextClass } from "../../src/core/03-context";
import { HttpError } from "../../src/core/09-errors";
import { isAllowedOrigin, normalizeOrigin } from "../../src/core/08-security";
import { readMultipart } from "../../src/lib/multipart";
import { createCsrfToken, verifyCsrfToken } from "../../src/lib/csrf";

test("normalizeOrigin canonicalizes schemes, ports and trailing slashes", () => {
    assert.equal(normalizeOrigin("https://Example.com:443/"), "https://example.com");
    assert.equal(normalizeOrigin("http://example.com:80/path?q=1"), "http://example.com");
    assert.equal(normalizeOrigin("http://example.com:8080"), "http://example.com:8080");
    assert.equal(normalizeOrigin("not a url"), null);
    assert.equal(normalizeOrigin(undefined), null);
});

test("isAllowedOrigin accepts canonical, actual host and proxy scheme changes", () => {
    assert.equal(isAllowedOrigin(undefined, null), true);
    assert.equal(isAllowedOrigin("http://localhost:3000", null), true);
    assert.equal(isAllowedOrigin("http://localhost:3000/", null), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:3000", "http://127.0.0.1:3000"), true);
    assert.equal(isAllowedOrigin("https://example.com", "http://example.com"), true);
    assert.equal(isAllowedOrigin("http://evil.example", "http://localhost:3000"), false);
    assert.equal(isAllowedOrigin("http://localhost:3001", "http://localhost:3000"), false);
    assert.equal(isAllowedOrigin("null", "http://localhost:3000"), false);
});

test("signed CSRF tokens reject empty, tampered and expired values", () => {
    const token = createCsrfToken();
    assert.equal(verifyCsrfToken(token), true);
    assert.equal(verifyCsrfToken(""), false);
    assert.equal(verifyCsrfToken(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")), false);
    assert.equal(verifyCsrfToken(createCsrfToken(Date.now() - 25 * 60 * 60 * 1000)), false);
});

test("verifyCsrf uses the signed token", () => {
    const ctx = Object.create(ContextClass.prototype) as Context;
    assert.equal(ctx.verifyCsrf(createCsrfToken()), true);
    assert.equal(ctx.verifyCsrf("a".repeat(64)), false);
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
    (ctx as unknown as { csrfToken: string }).csrfToken = token;
    return ctx;
}

test("multipart bodies are parsed once and must carry the CSRF token", async () => {
    const good = await readMultipart(multipartContext(createCsrfToken()));
    assert.equal(good.fields.techname, "Tool");

    await assert.rejects(
        () => readMultipart(multipartContext("b".repeat(64))),
        (error: unknown) => error instanceof HttpError && error.status === 403
    );
});
