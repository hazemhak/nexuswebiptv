/**
 * M3U Export Router
 *
 * Exposes endpoints allowing external IPTV players (TiviMate, IPTV Smarters,
 * VLC, Kodi, Smart TVs) to connect to IPTVnator and retrieve playlists where
 * all video/audio streams are automatically rewritten to route through the
 * VPS server stream proxy.
 */

import express, { Router, Request, Response } from 'express';
import type { ServerStorage } from './storage/server-storage';
import { legacySourceDocument } from './storage/legacy-source-document';
import { streamXtreamM3u } from './m3u-export-xtream';
import {
    M3uExportEntry,
    sortExportEntries,
    detectContentType,
    formatCategory,
    parseSeriesEpisode,
    formatMovieTitle,
    escapeAttr,
    buildProxiedStreamUrl,
} from './m3u-export-classifier';
import { sharedStreamCatalog } from './stream-catalog-service';

export function createExportHandler(
    storage: ServerStorage | null,
    accessToken: string | null,
    uiPassword?: string | null
): (req: Request, res: Response) => Promise<void> {
    return async (req: Request, res: Response) => {
        if (!storage) {
            res.status(503).send('#EXTM3U\n# Error: Server storage is disabled\n');
            return;
        }

        const effectiveToken = extractRequestToken(req) || accessToken || uiPassword || null;
        const rawParamId = req.params['id'] || req.params['playlistId'];
        let targetId = (Array.isArray(rawParamId) ? rawParamId[0] : rawParamId) || '';
        if (!targetId && typeof req.query['username'] === 'string') {
            const u = req.query['username'].trim();
            if (u && u !== 'admin' && u !== 'all' && u !== accessToken && u !== uiPassword) {
                targetId = u;
            }
        }

        if (req.path.includes('/token/')) {
            const parts = req.path.split('/token/')[1]?.split('/') || [];
            if (
                parts.length >= 3 &&
                !parts[1].endsWith('.m3u') &&
                parts[1] !== 'type' &&
                parts[1] !== 'direct'
            ) {
                targetId = decodeURIComponent(parts[1]).replace(/\.m3u8?$/i, '');
            }
        }

        const streamType = resolveStreamType(req);
        const filename =
            streamType === 'live'
                ? 'live.m3u'
                : streamType === 'movie'
                ? 'movies.m3u'
                : streamType === 'series'
                ? 'series.m3u'
                : 'playlist.m3u';

        res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

        if (targetId) {
            const playlistId = targetId.replace(/\.m3u8?$/i, '');
            if (playlistId !== 'all' && playlistId !== 'playlist') {
                let doc = storage.playlists.get(playlistId);
                if (!doc) {
                    const all = storage.playlists.listAll();
                    const targetLower = playlistId.toLowerCase();
                    const targetSlug = targetLower.replace(/[^a-z0-9]+/g, '');
                    doc = all.find((p) => {
                        const title = String(p.title ?? '').toLowerCase().trim();
                        const slug = title.replace(/[^a-z0-9]+/g, '');
                        return title === targetLower || (slug && slug === targetSlug);
                    }) ?? null;
                }
                if (!doc) {
                    res.status(404).send('#EXTM3U\n# Error: Playlist not found\n');
                    return;
                }

                const legacy = legacySourceDocument(doc) as Record<string, unknown>;
                await streamM3uPlaylists([legacy], req, res, effectiveToken, streamType);
                return;
            }
        }

        const allPlaylists = storage.playlists
            .listAll()
            .map((doc) => legacySourceDocument(doc) as Record<string, unknown>);

        await streamM3uPlaylists(allPlaylists, req, res, effectiveToken, streamType);
    };
}

export function createM3uExportRouter(
    storage: ServerStorage | null,
    accessToken: string | null,
    uiPassword?: string | null,
    customExportHandler?: (req: Request, res: Response) => Promise<void>
): Router {
    const router = Router();
    const exportHandler = customExportHandler || createExportHandler(storage, accessToken, uiPassword);

    const checkAuth = (req: Request, res: Response, next: () => void) => {
        if (!accessToken && !uiPassword) {
            return next();
        }

        const providedToken = extractRequestToken(req);
        if (
            (accessToken && providedToken === accessToken) ||
            (uiPassword && providedToken === uiPassword)
        ) {
            return next();
        }

        res.status(401).send(
            '#EXTM3U\n# Unauthorized: Invalid or missing access token\n'
        );
    };

    router.get(['/m3u/status', '/api/m3u/status'], (_req: Request, res: Response) => {
        const count = storage ? storage.playlists.count() : 0;
        res.json({ count });
    });

    router.post(
        ['/m3u/sync', '/api/m3u/sync'],
        checkAuth,
        express.json({ limit: '64mb' }),
        (req: Request, res: Response) => {
            if (!storage) {
                res.status(503).json({ error: 'Server storage disabled' });
                return;
            }
            const body = req.body;
            const playlists = Array.isArray(body?.playlists) ? body.playlists : [];
            let imported = 0;
            for (const p of playlists) {
                if (!p || typeof p !== 'object') continue;
                const id = String(p['_id'] || p['id'] || '');
                if (!id) continue;
                storage.playlists.upsert(p as Record<string, unknown>, { keepPayload: false });
                imported++;
            }
            res.json({ success: true, imported, total: storage.playlists.count() });
        }
    );

    const routes = [
        /^\/(?:api\/)?(?:m3u|playlist|live|movies|series)(?:\.m3u8?)?$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/direct\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/type\/([^/]+)\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/type\/([^/]+)\/direct\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/([^/]+)\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/([^/]+)\/direct\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/([^/]+)\/type\/([^/]+)\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/token\/([^/]+)\/([^/]+)\.m3u$/,
        /^\/(?:api\/)?m3u\/type\/([^/]+)\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/direct\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/([^/]+)\/(?:playlist|live|movies|series)\.m3u$/,
        /^\/(?:api\/)?m3u\/([^/]+)(?:\.m3u8?)?$/,
    ];

    for (const r of routes) {
        router.get(r, checkAuth, exportHandler);
        router.head(r, checkAuth, exportHandler);
    }

    return router;
}

function resolveStreamType(req: Request): string {
    const path = req.path.toLowerCase();
    if (path.includes('live.m3u')) return 'live';
    if (path.includes('movies.m3u') || path.includes('movie.m3u')) return 'movie';
    if (path.includes('series.m3u')) return 'series';

    const paramType = typeof req.params['type'] === 'string' ? req.params['type'] : '';
    const pathMatch = req.path.match(/\/type\/([^/]+)/)?.[1] ?? '';
    const queryType =
        (typeof req.query['stream_type'] === 'string' ? req.query['stream_type'] : '') ||
        (typeof req.query['type'] === 'string' &&
        req.query['type'] !== 'm3u' &&
        req.query['type'] !== 'm3u_plus'
            ? req.query['type']
            : '');

    return (paramType || pathMatch || queryType).trim().toLowerCase();
}

async function streamM3uPlaylists(
    playlists: Array<Record<string, unknown>>,
    req: Request,
    res: Response,
    serverToken: string | null,
    streamType: string
): Promise<void> {
    const hostBase = getHostBaseUrl(req);
    const isDirect = req.path.includes('/direct');
    const proxyQuery = typeof req.query['proxy'] === 'string' ? req.query['proxy'].trim().toLowerCase() : '';
    const useProxy = !isDirect && proxyQuery !== '0' && proxyQuery !== 'false' && proxyQuery !== 'no';
    const outputFormat = typeof req.query['output'] === 'string' ? req.query['output'].trim() : '';

    const playlistWithEpg = playlists.find(
        (p) => Array.isArray(p['epgUrls']) && p['epgUrls'].length > 0
    );
    const rawEpg = playlistWithEpg ? (playlistWithEpg['epgUrls'] as unknown[]) : null;
    const epgUrl = rawEpg && typeof rawEpg[0] === 'string' ? rawEpg[0] : null;
    if (epgUrl) {
        res.write(`#EXTM3U url-tvg="${escapeAttr(epgUrl)}"\n`);
    } else {
        res.write('#EXTM3U\n');
    }

    if (playlists.length === 0) {
        res.write(
            '#EXTINF:-1 tvg-id="" tvg-name="No Playlists on Server" group-title="IPTVnator | Setup",No Playlists Found - Please Sync in Settings\n' +
            `${hostBase}/live/info.ts\n`
        );
        res.end();
        return;
    }

    const allEntries: M3uExportEntry[] = [];
    const tokenParam = serverToken ? `&token=${encodeURIComponent(serverToken)}` : '';

    for (const p of playlists) {
        if (p['serverUrl'] && p['username'] && p['password']) {
            await streamXtreamM3u(
                String(p['serverUrl']).replace(/\/+$/, ''),
                String(p['username']),
                String(p['password']),
                outputFormat,
                streamType,
                hostBase,
                serverToken,
                res,
                useProxy
            );
            continue;
        }

        const playlistObj = p['playlist'] as Record<string, unknown> | undefined;
        const items = (playlistObj?.['items'] || p['items'] || []) as Array<Record<string, unknown>>;
        const playlistTitle = (p['title'] as string) || 'IPTV';

        for (const item of items) {
            const rawUrl = (item['url'] as string) || '';
            if (!rawUrl) continue;

            const name = (item['name'] as string) || 'Channel';
            const tvg = (item['tvg'] as Record<string, string>) || {};
            const group = (item['group'] as Record<string, string>) || {};
            const rawGroup = group['title'] || playlistTitle;

            const contentType = detectContentType(rawUrl, name, rawGroup);

            if (streamType === 'live' && contentType !== 'live') continue;
            if ((streamType === 'movie' || streamType === 'vod' || streamType === 'movies') && contentType !== 'movie') continue;
            if ((streamType === 'series' || streamType === 'tvshows' || streamType === 'tv') && contentType !== 'series') continue;

            const groupTitle = formatCategory(rawGroup, contentType);
            const tvgLogo = tvg['logo'] || '';
            const rawTvgId = tvg['id'] || '';

            sharedStreamCatalog.register({ id: name, type: contentType, url: rawUrl, name });

            if (contentType === 'series') {
                const parsed = parseSeriesEpisode(name, rawGroup);
                const streamUrl = useProxy
                    ? buildProxiedStreamUrl(hostBase, 'series', rawUrl, tokenParam, '1')
                    : rawUrl;
                const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(parsed.displayTitle)}" tvg-logo="${escapeAttr(tvgLogo)}" group-title="${escapeAttr(groupTitle)}",${parsed.displayTitle}`;
                allEntries.push({
                    type: 'series',
                    extinf,
                    streamUrl,
                    groupTitle,
                    title: parsed.seriesTitle,
                    season: parsed.season,
                    episode: parsed.episode,
                });
            } else if (contentType === 'movie') {
                const movieTitle = formatMovieTitle(name);
                const streamUrl = useProxy
                    ? buildProxiedStreamUrl(hostBase, 'movie', rawUrl, tokenParam)
                    : rawUrl;
                const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(movieTitle)}" tvg-logo="${escapeAttr(tvgLogo)}" group-title="${escapeAttr(groupTitle)}",${movieTitle}`;
                allEntries.push({
                    type: 'movie',
                    extinf,
                    streamUrl,
                    groupTitle,
                    title: movieTitle,
                });
            } else {
                const streamUrl = useProxy
                    ? buildProxiedStreamUrl(hostBase, 'live', rawUrl, tokenParam)
                    : rawUrl;
                const tvgIdAttr = rawTvgId ? `tvg-id="${escapeAttr(rawTvgId)}" ` : '';
                const tvgNameAttr = tvg['name'] ? `tvg-name="${escapeAttr(tvg['name'])}" ` : `tvg-name="${escapeAttr(name)}" `;
                const extinf = `#EXTINF:-1 ${tvgIdAttr}${tvgNameAttr}tvg-logo="${escapeAttr(tvgLogo)}" group-title="${escapeAttr(groupTitle)}",${name}`;
                allEntries.push({
                    type: 'live',
                    extinf,
                    streamUrl,
                    groupTitle,
                    title: name,
                });
            }
        }
    }

    const sorted = sortExportEntries(allEntries);
    for (const entry of sorted) {
        if (res.writableEnded || res.destroyed) break;
        res.write(`${entry.extinf}\n${entry.streamUrl}\n`);
    }

    if (!res.writableEnded) {
        res.end();
    }
}

function getHostBaseUrl(req: Request): string {
    const rawProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const proto = (Array.isArray(rawProto) ? rawProto[0] : String(rawProto)).split(',')[0].trim() || 'http';
    const rawHost = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const host = (Array.isArray(rawHost) ? rawHost[0] : String(rawHost)).split(',')[0].trim() || 'localhost';
    return `${proto}://${host}`;
}

function extractRequestToken(req: Request): string {
    if (typeof req.params['token'] === 'string' && req.params['token'].trim()) {
        return req.params['token'].trim();
    }
    const tokenMatch = req.path.match(/\/token\/([^/]+)/);
    if (tokenMatch) {
        return decodeURIComponent(tokenMatch[1]).trim();
    }

    const query = req.query;
    const fromQuery =
        (typeof query['token'] === 'string' ? query['token'] : '') ||
        (typeof query['access_token'] === 'string' ? query['access_token'] : '') ||
        (typeof query['auth'] === 'string' ? query['auth'] : '') ||
        (typeof query['key'] === 'string' ? query['key'] : '') ||
        (typeof query['password'] === 'string' ? query['password'] : '') ||
        (typeof query['pass'] === 'string' ? query['pass'] : '') ||
        (typeof query['secret'] === 'string' ? query['secret'] : '');

    if (fromQuery) return fromQuery.trim();

    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }

    return '';
}
