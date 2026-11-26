import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readMultipart } from "../../src/lib/multipart";

test("parses a mixed-case browser boundary", async () => {
    const boundary = "----WebKitFormBoundaryAbCdEf123456";
    const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="techname"',
        "",
        "Mixed Case Tool",
        `--${boundary}`,
        'Content-Disposition: form-data; name="_csrf"',
        "",
        "signed-token",
        `--${boundary}--`,
        "",
    ].join("\r\n");

    const raw = Readable.from([Buffer.from(body)]);
    const ctx = {
        raw: Object.assign(raw, {
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        }),
        verifyCsrf: (value: string) => value === "signed-token",
    };

    const result = await readMultipart(ctx as never);
    assert.equal(result.fields.techname, "Mixed Case Tool");
    assert.equal(result.fields._csrf, "signed-token");
});
