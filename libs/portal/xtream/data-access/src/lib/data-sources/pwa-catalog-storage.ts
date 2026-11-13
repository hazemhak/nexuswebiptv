const DB_NAME = 'iptvnator-pwa-catalog';
const STORE_NAME = 'cache';
const DB_VERSION = 1;

export const PWA_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheRecord<T> {
    readonly key: string;
    readonly timestamp: number;
    readonly items: T;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDb(): Promise<IDBDatabase | null> {
    if (dbPromise) {
        return dbPromise;
    }

    if (typeof indexedDB === 'undefined') {
        dbPromise = Promise.resolve(null);
        return dbPromise;
    }

    dbPromise = new Promise((resolve) => {
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                resolve(null);
            };
        } catch {
            resolve(null);
        }
    });

    return dbPromise;
}

export async function getPwaCatalogCache<T>(
    key: string,
    maxAgeMs = PWA_CATALOG_CACHE_TTL_MS
): Promise<{ timestamp: number; items: T } | null> {
    try {
        const db = await getDb();
        if (!db) {
            return null;
        }

        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);

            request.onsuccess = () => {
                const record = request.result as CacheRecord<T> | undefined;
                if (!record || !record.items) {
                    resolve(null);
                    return;
                }

                if (Date.now() - record.timestamp > maxAgeMs) {
                    resolve(null);
                    return;
                }

                resolve({ timestamp: record.timestamp, items: record.items });
            };

            request.onerror = () => {
                resolve(null);
            };
        });
    } catch {
        return null;
    }
}

export async function setPwaCatalogCache<T>(
    key: string,
    items: T
): Promise<void> {
    try {
        const db = await getDb();
        if (!db) {
            return;
        }

        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const record: CacheRecord<T> = {
                key,
                timestamp: Date.now(),
                items,
            };
            const request = store.put(record);

            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
        });
    } catch {
        // Ignore cache write failure
    }
}

export async function clearPwaCatalogCache(playlistId: string): Promise<void> {
    try {
        const db = await getDb();
        if (!db) {
            return;
        }

        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.openCursor();

            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    if (String(cursor.key).startsWith(playlistId)) {
                        cursor.delete();
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };

            request.onerror = () => resolve();
        });
    } catch {
        // Ignore cache clear failure
    }
}
