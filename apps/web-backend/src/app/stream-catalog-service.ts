/**
 * Stream Catalog Service
 *
 * Maintains an in-memory registry of stream IDs mapped to upstream stream URLs
 * so that Xtream-style playback paths (/live/:u/:p/:id, /movie/:u/:p/:id, /series/:u/:p/:id)
 * can resolve the target media URL even when external players strip query parameters.
 */

export interface CatalogStreamEntry {
    readonly id: string | number;
    readonly type: 'live' | 'movie' | 'series';
    readonly url: string;
    readonly name?: string;
    readonly categoryId?: string;
}

export class StreamCatalogService {
    private readonly entries = new Map<string, CatalogStreamEntry>();

    register(entry: CatalogStreamEntry): void {
        this.entries.set(String(entry.id), entry);
    }

    lookup(id: string | number): CatalogStreamEntry | undefined {
        return this.entries.get(String(id));
    }

    clear(): void {
        this.entries.clear();
    }

    size(): number {
        return this.entries.size;
    }
}

export const sharedStreamCatalog = new StreamCatalogService();
