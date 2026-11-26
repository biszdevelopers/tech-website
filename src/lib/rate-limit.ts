type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

/**
 * O(1) fixed-window limiter. At the cap, expired entries are swept; if the map
 * is still full, the new key is refused. Evicting a live bucket would let an
 * attacker reset somebody else's throttle by flooding unique keys.
 *
 * `cost` lets one request consume several units (for example, a CSV import
 * with 12 tools counts as 12 submissions).
 */
export function rateLimitBy(key: string, cost: number, limit: number, windowMs: number): boolean {
    const units = Math.max(1, Math.floor(cost));
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
        if (units > limit) return false;
        if (buckets.size >= MAX_BUCKETS) {
            for (const [existingKey, existing] of buckets) {
                if (now > existing.resetAt) buckets.delete(existingKey);
            }
            if (buckets.size >= MAX_BUCKETS) return false;
        }
        buckets.set(key, { count: units, resetAt: now + windowMs });
        return true;
    }
    if (bucket.count + units > limit) return false;
    bucket.count += units;
    return true;
}

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
    return rateLimitBy(key, 1, limit, windowMs);
}
