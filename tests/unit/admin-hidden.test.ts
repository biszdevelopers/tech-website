import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "../../src/core/03-context";
import { HttpError } from "../../src/core/09-errors";
import { requireMainAdmin } from "../../src/routes/guards";

const anonymous = {
    cookie: () => undefined,
    throw: (status: number, message?: string) => {
        throw new HttpError(status, message);
    },
} as unknown as Context;

test("anonymous admin requests look like any other missing page", async () => {
    await assert.rejects(
        () => requireMainAdmin(anonymous),
        (error: unknown) => error instanceof HttpError && error.status === 404
    );
});
