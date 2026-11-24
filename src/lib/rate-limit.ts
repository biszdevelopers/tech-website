type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

/**
 * O(1) fixed-window limiter. At the cap, expired entries are swept; if the map
 * is still full, the new key is refused. Evicting a live bucket would let an
 * attacker reset somebody else's throttle by flooding unique keys.
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
        if (buckets.size >= MAX_BUCKETS) {
            for (const [existingKey, existing] of buckets) {
                if (now > existing.resetAt) buckets.delete(existingKey);
            }
            if (buckets.size >= MAX_BUCKETS) return false;
        }
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
}
