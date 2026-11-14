#!/usr/bin/env node
/**
 * Copies passthrough assets into the dev tree. Compiler outputs (js/css) are
 * owned by the watchers; this script never touches them.
 */
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/public", { recursive: true });
cpSync("public", "dist/public", { recursive: true });
cpSync("src/views", "dist/views", { recursive: true });
console.log("[assets] public + views -> dist");
