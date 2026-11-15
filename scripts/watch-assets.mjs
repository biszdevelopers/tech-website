#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, watch, mkdirSync } from "node:fs";
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

mkdirSync("dist/public/css", { recursive: true });
mkdirSync("dist/public/js/modern", { recursive: true });

async function buildCss() {
    for (const file of readdirSync("src/styles").filter((f) => f.endsWith(".css"))) {
        try {
            const source = readFileSync(join("src/styles", file), "utf8");
            const processed = await postcss([
                autoprefixer({
                    overrideBrowserslist: ["ie 11", "> 0.5%", "not dead"],
                    grid: false,
                }),
            ]).process(source, { from: join("src/styles", file) });
            writeFileSync(join("dist/public/css", file), processed.css);
            console.log("[styles]", file);
        } catch (error) {
            console.error("[styles]", error instanceof Error ? error.message : error);
        }
    }
}

await buildCss();
const modern = await esbuild.context({
    entryPoints: CLIENT_ENTRIES.map((name) => `src/client/${name}.ts`),
    outdir: "dist/public/js/modern",
    bundle: false,
    format: "iife",
    target: "es2015",
    logLevel: "info",
});
await modern.watch();

let timer;
watch("src/styles", { persistent: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void buildCss(), 100);
});
console.log("[watch] css + modern client watching");
