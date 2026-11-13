/**
 * M3U Content Classifier & Normalizer
 *
 * Accurately categorizes IPTV streams into Live TV, Movies, and Series so
 * that external players (IPTV Smarters, TiviMate, VLC) display each in their
 * respective dashboards and never mix series episodes into movies.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type ExportContentType = 'live' | 'movie' | 'series';

/**
 * Classifies a stream item based on URL patterns, episode identifiers, and group titles.
 * Series detection has highest priority to prevent episodic video files (.mp4/.mkv)
 * from being misclassified as Movies.
 */
export function detectContentType(
    url: string,
    name?: string,
    group?: string
): ExportContentType {
    const rawUrl = url || '';
    const rawName = name || '';
    const rawGroup = group || '';

    // 1. Series check (highest priority: /series/ path, SxxExx in title/group, or series keyword in group)
    const isSeries =
        rawUrl.includes('/series/') ||
        /\b(series|tv\s*shows?|shows?|serials?|seasons?|serien|s[eé]ries)\b/i.test(rawGroup) ||
        /\bS\d{1,2}\s*[._-]?\s*E\d{1,3}\b/i.test(rawName) ||
        /\b\d{1,2}x\d{1,3}\b/i.test(rawName) ||
        /\bSeason\s*\d+\b/i.test(rawName) ||
        /\b(?:ep|episode)\.?\s*\d+\b/i.test(rawName) ||
        /(?:مسلسل|مسلسلات|حلقة\s*\d+)/.test(rawName) ||
        /(?:مسلسل|مسلسلات)/.test(rawGroup);

    if (isSeries) {
        return 'series';
    }

    // 2. Movie / VOD check (URLs with /movie/, /vod/, video extension, or movie in group)
    const isMovie =
        rawUrl.includes('/movie/') ||
        rawUrl.includes('/vod/') ||
        /\.(mp4|mkv|avi|mov|wmv)(\?|$)/i.test(rawUrl) ||
        /\b(movies?|vod|films?|cinema|افلام|فيلم)\b/i.test(rawGroup);

    if (isMovie) {
        return 'movie';
    }

    return 'live';
}

export function formatMovieCategory(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) return 'Movies';
    if (
        /^(movies?|vod|films?)\b/i.test(trimmed) ||
        /\b(movies?|vod|films?)$/i.test(trimmed) ||
        /(?:افلام|فيلم)/.test(trimmed)
    ) {
        return trimmed;
    }
    return `Movies - ${trimmed}`;
}

export function formatSeriesCategory(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) return 'Series';
    if (
        /^(series|tv\s*shows?|shows?|serials?|seasons?|serien|s[eé]ries)\b/i.test(trimmed) ||
        /\b(series|tv\s*shows?|shows?|serials?|seasons?|serien|s[eé]ries)$/i.test(trimmed) ||
        /(?:مسلسل|مسلسلات)/.test(trimmed)
    ) {
        return trimmed;
    }
    return `Series - ${trimmed}`;
}

export function extractMediaBasename(url: string, fallback: string): string {
    try {
        const parsed = new URL(url);
        const lastPart = parsed.pathname.split('/').filter(Boolean).pop();
        if (lastPart && /\.[a-z0-9]{2,4}$/i.test(lastPart)) {
            return lastPart;
        }
        if (lastPart && /^\d+$/.test(lastPart)) {
            return lastPart + (fallback.endsWith('.ts') ? '.ts' : '.mp4');
        }
    } catch {
        // Ignore parsing errors
    }
    return fallback;
}

export function escapeAttr(val: string): string {
    return (val || '').replace(/"/g, "'");
}

export function rewriteExtinfGroup(
    extinf: string,
    contentType: ExportContentType,
    groupName: string,
    streamName: string
): string {
    if (!extinf) return '';
    const hasGroup = /group-title="[^"]*"/i.test(extinf);
    if (contentType === 'series') {
        const formatted = formatSeriesCategory(groupName || streamName);
        return hasGroup
            ? extinf.replace(/group-title="[^"]*"/i, `group-title="${escapeAttr(formatted)}"`)
            : extinf.replace(/^(#EXTINF:-?\d+)/, `$1 group-title="${escapeAttr(formatted)}"`);
    } else if (contentType === 'movie') {
        const formatted = formatMovieCategory(groupName || 'Movies');
        return hasGroup
            ? extinf.replace(/group-title="[^"]*"/i, `group-title="${escapeAttr(formatted)}"`)
            : extinf.replace(/^(#EXTINF:-?\d+)/, `$1 group-title="${escapeAttr(formatted)}"`);
    }
    return extinf;
}

export function buildProxiedStreamUrl(
    proxyBase: string,
    contentType: ExportContentType,
    fullUrl: string,
    tokenParam: string
): string {
    const subpath = contentType === 'series' ? 'series' : contentType === 'movie' ? 'movie' : 'live';
    const fallback = contentType === 'live' ? 'stream.ts' : 'video.mp4';
    const basename = extractMediaBasename(fullUrl, fallback);
    return `${proxyBase}/stream-proxy/${subpath}/${basename}?url=${encodeURIComponent(fullUrl)}${tokenParam}`;
}

export function fetchXtreamJson<T>(targetUrl: string, hopCount = 0): Promise<T | null> {
    if (hopCount > 5) return Promise.resolve(null);
    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL(targetUrl);
        } catch {
            return resolve(null);
        }
        const makeRequest = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = makeRequest(
            targetUrl,
            {
                headers: {
                    'User-Agent': 'IPTVSmarters/2.2.2.1',
                    Accept: 'application/json, */*',
                },
                timeout: 15000,
                rejectUnauthorized: false,
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    const redirectUrl = new URL(res.headers.location, targetUrl).href;
                    return resolve(fetchXtreamJson<T>(redirectUrl, hopCount + 1));
                }
                if (status !== 200) {
                    res.resume();
                    return resolve(null);
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on('end', () => {
                    try {
                        const text = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(text);
                        resolve(data as T);
                    } catch {
                        resolve(null);
                    }
                });
                res.on('error', () => resolve(null));
            }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}
