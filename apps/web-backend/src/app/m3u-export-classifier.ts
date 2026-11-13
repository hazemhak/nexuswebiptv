/**
 * M3U Content Classifier & Normalizer
 *
 * Implements conventions for IPTV Smarters, VLC, and TiviMate:
 * - Content classification into live, movie, series
 * - Category normalization: "Live | ...", "Movies | ...", "Series | ..."
 * - Stream URL conventions: /live/<id>.ts, /movie/<id>.mp4, /series/<sid>/<id>.mp4
 * - Entry formats: SxxExx for series, Title (Year) for movies, tvg-id="" for VOD
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type ExportContentType = 'live' | 'movie' | 'series';

export interface FormattedSeries {
    readonly seriesTitle: string;
    readonly season: number;
    readonly episode: number;
    readonly displayTitle: string;
}

export interface M3uExportEntry {
    readonly type: ExportContentType;
    readonly extinf: string;
    readonly streamUrl: string;
    readonly groupTitle: string;
    readonly title: string;
    readonly season?: number;
    readonly episode?: number;
}

export function sortExportEntries(entries: M3uExportEntry[]): M3uExportEntry[] {
    const live: M3uExportEntry[] = [];
    const movies: M3uExportEntry[] = [];
    const series: M3uExportEntry[] = [];

    for (const e of entries) {
        if (e.type === 'series') series.push(e);
        else if (e.type === 'movie') movies.push(e);
        else live.push(e);
    }

    live.sort((a, b) => a.groupTitle.localeCompare(b.groupTitle) || a.title.localeCompare(b.title));
    movies.sort((a, b) => a.groupTitle.localeCompare(b.groupTitle) || a.title.localeCompare(b.title));
    series.sort((a, b) => {
        const groupCmp = a.groupTitle.localeCompare(b.groupTitle);
        if (groupCmp !== 0) return groupCmp;
        const titleCmp = a.title.localeCompare(b.title);
        if (titleCmp !== 0) return titleCmp;
        const sDiff = (a.season ?? 1) - (b.season ?? 1);
        if (sDiff !== 0) return sDiff;
        return (a.episode ?? 1) - (b.episode ?? 1);
    });

    return [...live, ...movies, ...series];
}

export function detectContentType(
    url?: string,
    name?: string,
    group?: string
): ExportContentType {
    const rawUrl = url || '';
    const rawName = name || '';
    const rawGroup = group || '';

    // 1. Series check (highest priority)
    const isSeries =
        rawUrl.includes('/series/') ||
        /\b(series|tv\s*shows?|shows?|serials?|seasons?|serien|s[eé]ries)\b/i.test(rawGroup) ||
        /\bS\d{1,2}\s*[._-]?\s*E\d{1,3}\b/i.test(rawName) ||
        /\b\d{1,2}x\d{1,3}\b/i.test(rawName) ||
        /\b(?:season|saison|temporada|staffel)\s*\d+\b/i.test(rawName) ||
        /\b(?:ep|episode)\.?\s*\d+\b/i.test(rawName) ||
        /(?:مسلسل|مسلسلات|حلقة\s*\d+|الحلقة\s*\d+|الموسم\s*\d+|الجزء\s*\d+)/.test(rawName) ||
        /(?:مسلسل|مسلسلات|دراما|انمي)/.test(rawGroup);

    if (isSeries) {
        return 'series';
    }

    // 2. Movie check
    const isMovie =
        rawUrl.includes('/movie/') ||
        rawUrl.includes('/vod/') ||
        /\.(mp4|mkv|avi|mov|wmv)(\?|$)/i.test(rawUrl) ||
        /\b(movies?|vod|films?|cinema|cinema|kino)\b/i.test(rawGroup) ||
        /(?:افلام|فيلم)/.test(rawGroup) ||
        /\(\d{4}\)/.test(rawName);

    if (isMovie) {
        return 'movie';
    }

    return 'live';
}

export function stripQualityTags(text: string): string {
    return text
        .replace(/\[\s*(?:4k|uhd|fhd|hd|sd|1080p|720p|bluray|web-dl|hevc|x264|x265)\s*\]/gi, '')
        .replace(/\(\s*(?:4k|uhd|fhd|hd|sd|1080p|720p|bluray|web-dl|hevc|x264|x265)\s*\)/gi, '')
        .replace(/\b(?:4k|uhd|fhd|1080p|720p|bluray|web-dl|webrip|hevc|x264|x265|h\.264|h\.265)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

export function formatCategory(group: string | undefined, type: ExportContentType): string {
    let clean = (group || '').trim();
    clean = clean.replace(/^(?:live|movies?|vod|films?|series|tv\s*shows?|shows?)\s*[|:–-]\s*/i, '');
    clean = clean.replace(/,/g, ' ').replace(/"/g, "'").replace(/\s{2,}/g, ' ').trim();

    if (type === 'live') {
        const cat = clean || 'Other';
        return `Live | ${cat}`;
    }
    if (type === 'movie') {
        const cat = clean || 'Other';
        return `Movies | ${cat}`;
    }
    const cat = clean || 'Other';
    return `Series | ${cat}`;
}

export function parseSeriesEpisode(name: string, group?: string): FormattedSeries {
    const raw = stripQualityTags(name || 'Series Episode');
    let seriesTitle = raw;
    let season = 1;
    let episode = 1;

    // Pattern 1: S01E01, S1E1, S01-E01, S01.E01
    const sPattern = /\bS(\d{1,2})\s*[._-]?\s*E(\d{1,3})\b/i.exec(raw);
    if (sPattern) {
        season = parseInt(sPattern[1], 10);
        episode = parseInt(sPattern[2], 10);
        seriesTitle = raw.slice(0, sPattern.index).trim();
    } else {
        // Pattern 2: 1x01
        const xPattern = /\b(\d{1,2})x(\d{1,3})\b/i.exec(raw);
        if (xPattern) {
            season = parseInt(xPattern[1], 10);
            episode = parseInt(xPattern[2], 10);
            seriesTitle = raw.slice(0, xPattern.index).trim();
        } else {
            // Pattern 3: Season X Episode Y
            const sePattern = /(?:season|saison|temporada|staffel)\s*(\d{1,2}).*?(?:ep|episode)\.?\s*(\d{1,3})/i.exec(raw);
            if (sePattern) {
                season = parseInt(sePattern[1], 10);
                episode = parseInt(sePattern[2], 10);
                seriesTitle = raw.slice(0, sePattern.index).trim();
            } else {
                // Pattern 4: Episode Y / Ep Y
                const epPattern = /\b(?:ep|episode)\.?\s*(\d{1,3})\b/i.exec(raw);
                if (epPattern) {
                    episode = parseInt(epPattern[1], 10);
                    seriesTitle = raw.slice(0, epPattern.index).trim();
                } else {
                    // Pattern 5: Arabic الحلقة X or الجزء X الحلقة Y
                    const arPattern = /(?:(?:الموسم|الجزء)\s*(\d+))?[ -._]*(?:حلقة|الحلقة|ح)\s*(\d+)/.exec(raw);
                    if (arPattern) {
                        if (arPattern[1]) season = parseInt(arPattern[1], 10);
                        if (arPattern[2]) episode = parseInt(arPattern[2], 10);
                        seriesTitle = raw.slice(0, arPattern.index).trim();
                    }
                }
            }
        }
    }

    // Clean series title
    seriesTitle = seriesTitle
        .replace(/[-_.:\s]+$/, '')
        .replace(/^\s*(?:مسلسل|series)\s*[:–-]\s*/i, '')
        .trim();

    if (!seriesTitle && group) {
        seriesTitle = group.replace(/^(?:series|tv\s*shows?)\s*[|:–-]\s*/i, '').trim();
    }
    if (!seriesTitle) {
        seriesTitle = 'Show';
    }

    const sStr = String(season).padStart(2, '0');
    const eStr = String(episode).padStart(2, '0');
    const displayTitle = `${seriesTitle} S${sStr}E${eStr}`;

    return { seriesTitle, season, episode, displayTitle };
}

export function formatMovieTitle(name: string): string {
    const raw = stripQualityTags(name || 'Movie');
    const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(raw);
    if (!yearMatch) {
        return raw;
    }
    const year = yearMatch[1];
    // Check if already Title (YYYY)
    if (new RegExp(`\\(${year}\\)$`).test(raw)) {
        return raw;
    }
    const titleWithoutYear = raw
        .replace(new RegExp(`\\(?${year}\\)?`), '')
        .replace(/[-_.:\s]+$/, '')
        .trim();
    return `${titleWithoutYear || 'Movie'} (${year})`;
}

export function getStreamExtension(type: ExportContentType, url: string): string {
    const lower = (url || '').toLowerCase();
    if (type === 'live') {
        return lower.includes('.m3u8') ? 'm3u8' : 'ts';
    }
    return lower.includes('.mkv') ? 'mkv' : 'mp4';
}

export function extractStreamId(url: string, fallback: string): string {
    try {
        const parsed = new URL(url);
        const lastPart = parsed.pathname.split('/').filter(Boolean).pop();
        if (lastPart) {
            const clean = lastPart.replace(/\.[a-z0-9]{2,5}$/i, '');
            if (clean) return clean;
        }
    } catch {
        // parsing fallback
    }
    return fallback;
}

export function deriveSeriesId(seriesTitle: string, explicitId?: string | number): string {
    if (explicitId) return String(explicitId);
    let hash = 0;
    for (let i = 0; i < seriesTitle.length; i++) {
        hash = (hash * 31 + seriesTitle.charCodeAt(i)) >>> 0;
    }
    return String(hash || 101);
}

export function escapeAttr(val: string): string {
    return (val || '').replace(/"/g, "'");
}

export function buildProxiedStreamUrl(
    hostBase: string,
    contentType: ExportContentType,
    fullUrl: string,
    tokenParam: string,
    seriesId?: string | number,
    itemId?: string | number
): string {
    const ext = getStreamExtension(contentType, fullUrl);
    const id = itemId ? String(itemId) : extractStreamId(fullUrl, 'stream');
    const encUrl = encodeURIComponent(fullUrl);

    if (contentType === 'series') {
        const sid = seriesId ? String(seriesId) : '1';
        return `${hostBase}/series/${sid}/${id}.${ext}?url=${encUrl}${tokenParam}`;
    }
    if (contentType === 'movie') {
        return `${hostBase}/movie/${id}.${ext}?url=${encUrl}${tokenParam}`;
    }
    return `${hostBase}/live/${id}.${ext}?url=${encUrl}${tokenParam}`;
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
                        resolve(JSON.parse(text) as T);
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
