/**
 * In-process keyed mutex. SQLite is synchronous but handlers await between
 * "check" and "write"; serialising per key closes those race windows for the
 * single-process deployment this app targets.
 *
 * shortcut: single Node process only; replace with SQL transactions if the app
 * ever runs more than one instance.
 */
const tails = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
    }
}
