import { webDb } from "./db/web";

export interface WebSettings {
    sitename: string;
    url: string;
    description: string;
    cooldown: number;
    cooldownTime: number;
    maxattacks: number;
    testboots: number;
    maintaince: string;
    stripeSecretKey: string;
    stripePubKey: string;
    paypal: string;
    bitcoin: string;
    btc_address: string;
}

let cache: WebSettings | null = null;

/** Settings are read on every /web request; cache the single row. */
export async function getWebSettings(): Promise<WebSettings> {
    if (cache) return cache;
    const row = await webDb.settings.findFirst();
    cache = {
        sitename: row?.sitename ?? "IPstress",
        url: row?.url ?? "",
        description: row?.description ?? "",
        cooldown: Number(row?.cooldown ?? 0),
        cooldownTime: Number(row?.cooldownTime ?? 0),
        maxattacks: Number(row?.maxattacks ?? 0),
        testboots: Number(row?.testboots ?? 0),
        maintaince: String(row?.maintaince ?? "0"),
        stripeSecretKey: String(row?.stripeSecretKey ?? ""),
        stripePubKey: String(row?.stripePubKey ?? ""),
        paypal: String(row?.paypal ?? ""),
        bitcoin: String(row?.bitcoin ?? ""),
        btc_address: String(row?.btc_address ?? ""),
    };
    return cache;
}

export function invalidateWebSettings(): void {
    cache = null;
}
