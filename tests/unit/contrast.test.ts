import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Vars = Record<string, string>;

function block(text: string, selector: string): Vars {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m").exec(text);
    if (!match) throw new Error(`Missing ${selector}`);
    const vars: Vars = {};
    for (const item of match[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
        vars[`--${item[1]}`] = item[2].trim();
    }
    return vars;
}

function luminance(hex: string): number {
    const value = hex.replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`Not a hex colour: ${hex}`);
    const channels = [0, 2, 4].map((index) => {
        const channel = parseInt(value.slice(index, index + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function ratio(foreground: string, background: string): number {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function assertPairs(label: string, vars: Vars, pairs: Array<[string, string, number]>): void {
    for (const [fg, bg, minimum] of pairs) {
        const foreground = vars[fg];
        const background = vars[bg];
        if (!foreground?.startsWith("#") || !background?.startsWith("#")) continue;
        const actual = ratio(foreground, background);
        assert.ok(
            actual >= minimum,
            `${label}: ${fg} on ${bg} is ${actual.toFixed(2)}:1, needs ${minimum}:1`
        );
    }
}

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const web = readFileSync(resolve(process.cwd(), "src/styles/web.css"), "utf8");

test("light site tokens meet WCAG AA text contrast", () => {
    const vars = block(tokens, ":root");
    assertPairs("site light", vars, [
        ["--color-ink-strong", "--color-bg", 4.5],
        ["--color-ink", "--color-panel", 4.5],
        ["--color-muted", "--color-panel", 4.5],
        ["--color-muted", "--color-surface", 4.5],
        ["--color-ink-on-accent", "--color-accent", 4.5],
        ["--color-highlight-ink", "--color-highlight", 4.5],
        ["--color-selection-ink", "--color-selection-bg", 4.5],
        ["--color-focus", "--color-panel", 3],
        ["--color-danger", "--color-panel", 4.5],
        ["--color-success", "--color-panel", 4.5],
        ["--color-warning", "--color-panel", 4.5],
    ]);
    assert.ok(ratio("#ffffff", vars["--color-nav-bg"]) >= 4.5);
    assert.ok(ratio("#ffffff", vars["--color-footer-bg"]) >= 4.5);
});

test("dark site tokens meet WCAG AA text contrast", () => {
    const vars = block(tokens, '[data-theme="dark"]');
    assertPairs("site dark", vars, [
        ["--color-ink-strong", "--color-bg", 4.5],
        ["--color-ink", "--color-panel", 4.5],
        ["--color-muted", "--color-panel", 4.5],
        ["--color-muted", "--color-surface", 4.5],
        ["--color-ink-on-accent", "--color-accent", 4.5],
        ["--color-highlight-ink", "--color-highlight", 3],
        ["--color-selection-ink", "--color-selection-bg", 4.5],
        ["--color-focus", "--color-panel", 3],
        ["--color-danger", "--color-panel", 4.5],
        ["--color-success", "--color-panel", 4.5],
        ["--color-warning", "--color-panel", 4.5],
    ]);
    assert.ok(ratio("#ffffff", vars["--color-nav-bg"]) >= 4.5);
    assert.ok(ratio("#ffffff", vars["--color-footer-bg"]) >= 4.5);
});

test("web theme button and text tokens meet WCAG AA", () => {
    const dark = block(web, ":root");
    const light = block(web, '[data-theme="light"]');
    assertPairs("web dark", dark, [
        ["--ip-text", "--ip-bg", 4.5],
        ["--ip-muted", "--ip-card", 4.5],
        ["--ip-on-accent", "--ip-accent", 4.5],
        ["--ip-on-accent-hover", "--ip-accent-hover", 4.5],
        ["--ip-on-success", "--ip-success", 4.5],
        ["--ip-on-danger", "--ip-danger", 4.5],
        ["--ip-kicker", "--ip-bg", 4.5],
    ]);
    assertPairs("web light", light, [
        ["--ip-text", "--ip-bg", 4.5],
        ["--ip-muted", "--ip-card", 4.5],
        ["--ip-on-accent", "--ip-accent", 4.5],
        ["--ip-on-accent-hover", "--ip-accent-hover", 4.5],
        ["--ip-on-success", "--ip-success", 4.5],
        ["--ip-on-danger", "--ip-danger", 4.5],
        ["--ip-kicker", "--ip-card", 4.5],
    ]);
});
