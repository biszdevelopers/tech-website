#!/usr/bin/env node
/**
 * Production build:
 *   server  -> tsc (CommonJS, Node 24)
 *   views   -> copied to dist/views
 *   public  -> passthrough assets
 *   CSS     -> PostCSS + autoprefixer (IE11), then minified
 *   client  -> tsc ES5 (legacy/nomodule) + esbuild ES2015 (modern/module), both minified
 *   assets  -> build-id.json + .gz/.br siblings
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import autoprefixer from "autoprefixer";

const CLIENT_ENTRIES = [
    "admin",
    "filters",
    "img-fallback",
    "menu",
    "scroll-top",
    "tabs",
    "theme",
    "theme-boot",
    "wheel",
];

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/public/js/modern", { recursive: true });
mkdirSync("dist/public/js/legacy", { recursive: true });
mkdirSync("dist/public/css", { recursive: true });

console.log("build: server (tsc)");
execSync("npx tsc -p tsconfig.build.json", { stdio: "inherit" });

console.log("build: views + public");
cpSync("src/views", "dist/views", { recursive: true });
cpSync("public", "dist/public", { recursive: true });

console.log("build: css");
for (const file of readdirSync("src/styles").filter((f) => f.endsWith(".css"))) {
    const source = readFileSync(join("src/styles", file), "utf8");
    const processed = await postcss([
        autoprefixer({ overrideBrowserslist: ["ie 11", "> 0.5%", "not dead"], grid: false }),
    ]).process(source, { from: join("src/styles", file) });
    const minified = await esbuild.transform(processed.css, { loader: "css", minify: true });
    writeFileSync(join("dist/public/css", file), minified.code);
}

console.log("build: client legacy (ES5)");
execSync("npx tsc -p src/client", { stdio: "inherit" });
for (const file of readdirSync("dist/public/js/legacy").filter((f) => f.endsWith(".js"))) {
    const path = join("dist/public/js/legacy", file);
    const minified = await esbuild.transform(readFileSync(path, "utf8"), {
        loader: "js",
        minify: true,
        target: "es5",
    });
    writeFileSync(path, minified.code);
}

console.log("build: client modern (ES2015)");
await esbuild.build({
    entryPoints: CLIENT_ENTRIES.map((name) => `src/client/${name}.ts`),
    outdir: "dist/public/js/modern",
    bundle: false,
    format: "iife",
    target: "es2015",
    minify: true,
    logLevel: "warning",
});

console.log("build: build id + precompress");
const hash = createHash("sha256");
for (const dir of ["dist/public/css", "dist/public/js/modern", "dist/public/js/legacy"]) {
    for (const file of readdirSync(dir).sort()) hash.update(file).update(readFileSync(join(dir, file)));
}
const id = hash.digest("hex").slice(0, 16);
writeFileSync("dist/build-id.json", JSON.stringify({ id }));
execSync("node scripts/precompress.mjs dist/public", { stdio: "inherit" });

console.log(`build: done (id ${id})`);
