type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

/**
 * O(1) fixed-window limiter. The map is bounded: inserting past the cap drops
 * the oldest entry instead of scanning the whole map (a spoofed-IP flood must
 * not turn into O(n) work per request).
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
        if (buckets.size >= MAX_BUCKETS) evictOldest(now);
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
}

function evictOldest(now: number): void {
    const first = buckets.keys().next();
    if (first.done) return;
    // Drop the oldest entry unconditionally. It is almost always expired;
    // when it is not, the trade-off is one extra request, never unbounded memory.
    buckets.delete(first.value);
    if (buckets.size >= MAX_BUCKETS) {
        for (const [key, bucket] of buckets) {
            if (now > bucket.resetAt) buckets.delete(key);
            break;
        }
    }
}
