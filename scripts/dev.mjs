#!/usr/bin/env node
import { spawn } from "node:child_process";

const children = [];

function run(name, command, color) {
    const child = spawn(command, { shell: true, stdio: "pipe" });
    const tag = `\x1b[${color}m[${name}]\x1b[0m`;
    const relay = (stream, out) =>
        stream.on("data", (chunk) =>
            chunk
                .toString()
                .split("\n")
                .filter(Boolean)
                .forEach((line) => out(`${tag} ${line}`))
        );
    relay(child.stdout, console.log);
    relay(child.stderr, console.error);
    children.push(child);
    return child;
}

console.log("dev: starting server + client + style watchers...");
run("assets", "node scripts/sync-dist.mjs", "90");
run("server", "npx tsx watch server.ts", "36");
run("client", "npx tsc -p src/client --watch --preserveWatchOutput", "33");
run("styles", "node scripts/watch-assets.mjs", "35");

function shutdown() {
    for (const child of children) child.kill();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
