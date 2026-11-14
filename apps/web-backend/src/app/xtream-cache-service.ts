/**
 * Xtream Cache Service
 *
 * Provides in-memory caching and in-flight request deduplication for Xtream Codes API
 * endpoints (/player_api.php). This prevents massive repeated JSON downloads from the
 * upstream IPTV provider when the user rapidly browses categories, channels, and VOD.
 */

interface CacheEntry<T> {
    readonly data: T;
    readonly expiresAt: number;
}

export class XtreamCacheService {
    private readonly cache = new Map<string, CacheEntry<unknown>>();
    private readonly inFlight = new Map<string, Promise<unknown>>();
    private readonly defaultTtlMs = 15 * 60 * 1000; // 15 minutes

    get<T>(key: string): T | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        return entry.data as T;
    }

    set<T>(key: string, data: T, ttlMs = this.defaultTtlMs): void {
        this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
    }

    async getOrFetch<T>(
        key: string,
        fetchFn: () => Promise<T>,
        ttlMs = this.defaultTtlMs
    ): Promise<T> {
        const cached = this.get<T>(key);
        if (cached !== undefined) return cached;

        const pending = this.inFlight.get(key);
        if (pending) return pending as Promise<T>;

        const promise = fetchFn()
            .then((data) => {
                if (data !== null && data !== undefined) {
                    this.set(key, data, ttlMs);
                }
                this.inFlight.delete(key);
                return data;
            })
            .catch((err) => {
                this.inFlight.delete(key);
                throw err;
            });

        this.inFlight.set(key, promise);
        return promise;
    }

    clear(): void {
        this.cache.clear();
        this.inFlight.clear();
    }
}

export const sharedXtreamCache = new XtreamCacheService();
