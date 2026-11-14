/**
 * Xtream Codes API Router
 *
 * Implements the standard Xtream Codes API specification (/player_api.php, /get.php, /xmltv.php)
 * allowing IPTV applications like IPTV Smarters, TiviMate, and XCIPTV to log in directly
 * via "Login with Xtream Codes API" and access Live TV, Movies, and TV Series.
 */

import { Router, Request, Response } from 'express';
import type { ServerStorage } from './storage/server-storage';
import { legacySourceDocument } from './storage/legacy-source-document';
import { fetchXtreamJson } from './m3u-export-classifier';
import { sharedStreamCatalog } from './stream-catalog-service';
import { sharedXtreamCache } from './xtream-cache-service';
import {
    buildLocalXtreamCatalog,
    buildVodInfoResponse,
    buildSeriesInfoResponse,
    buildUserInfo,
    buildServerInfo,
    type LocalXtreamData,
} from './xtream-local-catalog';

export function createXtreamApiRouter(
    storage: ServerStorage | null,
    accessToken: string | null,
    uiPassword?: string | null,
    exportHandler?: (req: Request, res: Response) => Promise<void>
): Router {
    const router = Router();

    const checkAuth = (req: Request): boolean => {
        if (!accessToken && !uiPassword) return true;
        const q = req.query;
        const b = req.body || {};
        const u = String(q['username'] || b['username'] || '').trim();
        const p = String(q['password'] || b['password'] || '').trim();
        const token = String(q['token'] || b['token'] || '').trim();
        const effective = u || p || token;

        if (accessToken && (u === accessToken || p === accessToken || token === accessToken)) return true;
        if (uiPassword && (u === uiPassword || p === uiPassword || token === uiPassword)) return true;
        return effective === accessToken || effective === uiPassword;
    };

    const playerApiHandler = async (req: Request, res: Response) => {
        if (!checkAuth(req)) {
            res.status(200).json({
                user_info: { auth: 0, status: 'Disabled', message: 'Invalid credentials' },
            });
            return;
        }

        const username = String(req.query['username'] || req.body?.username || 'admin');
        const password = String(req.query['password'] || req.body?.password || '');
        const action = String(req.query['action'] || req.body?.action || '').trim().toLowerCase();
        const categoryId = String(req.query['category_id'] || req.body?.category_id || '').trim();
        const seriesId = String(req.query['series_id'] || req.body?.series_id || '').trim();
        const vodId = String(req.query['vod_id'] || req.query['stream_id'] || req.body?.vod_id || '').trim();

        if (!action) {
            res.json({
                user_info: buildUserInfo(username, password),
                server_info: buildServerInfo(req),
            });
            return;
        }

        const playlists = storage
            ? storage.playlists.listAll().map((d) => legacySourceDocument(d) as Record<string, unknown>)
            : [];

        // Check for upstream Xtream source
        const xtreamSource = playlists.find((p) => p['serverUrl'] && p['username'] && p['password']);
        if (xtreamSource) {
            const clean = String(xtreamSource['serverUrl']).replace(/\/+$/, '');
            const u = encodeURIComponent(String(xtreamSource['username']));
            const p = encodeURIComponent(String(xtreamSource['password']));

            const forwardQuery = buildForwardQuery(req, u, p);
            const targetUrl = `${clean}/player_api.php?${forwardQuery}`;

            // Fast cached responses for upstream Xtream to avoid repeated multi-megabyte downloads
            const data = await handleUpstreamXtreamAction(action, targetUrl, clean, u, p, categoryId, seriesId, vodId);
            if (data !== null) {
                res.json(data);
                return;
            }
        }

        // Handle catalog from stored M3U / local playlists
        res.json(handleLocalXtreamAction(action, playlists, categoryId, seriesId, vodId));
    };

    const getPhpHandler = async (req: Request, res: Response) => {
        if (!checkAuth(req)) {
            res.status(401).send('#EXTM3U\n# Unauthorized: Invalid or missing credentials\n');
            return;
        }
        if (exportHandler) {
            await exportHandler(req, res);
        } else {
            res.status(404).send('#EXTM3U\n# Export handler unavailable\n');
        }
    };

    const xmltvHandler = (req: Request, res: Response) => {
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.send('<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="IPTVnator"></tv>');
    };

    router.get(['/player_api.php', '/api/player_api.php'], playerApiHandler);
    router.post(['/player_api.php', '/api/player_api.php'], playerApiHandler);
    router.get(['/get.php', '/api/get.php'], getPhpHandler);
    router.get(['/xmltv.php', '/api/xmltv.php'], xmltvHandler);

    return router;
}

function buildForwardQuery(req: Request, u: string, p: string): string {
    const params = new URLSearchParams();
    params.set('username', u);
    params.set('password', p);
    for (const [k, v] of Object.entries(req.query)) {
        if (k !== 'username' && k !== 'password' && typeof v === 'string') {
            params.set(k, v);
        }
    }
    for (const [k, v] of Object.entries(req.body || {})) {
        if (k !== 'username' && k !== 'password' && typeof v === 'string') {
            params.set(k, v);
        }
    }
    const action = (params.get('action') || '').toLowerCase();
    if (action === 'get_vod_info') {
        const id = params.get('vod_id') || params.get('stream_id');
        if (id) {
            params.set('vod_id', id);
            params.set('stream_id', id);
        }
    } else if (action === 'get_series_info') {
        const id = params.get('series_id') || params.get('stream_id');
        if (id) {
            params.set('series_id', id);
        }
    }
    return params.toString();
}

async function handleUpstreamXtreamAction(
    action: string,
    targetUrl: string,
    clean: string,
    u: string,
    p: string,
    categoryId: string,
    _seriesId: string,
    vodId: string
): Promise<unknown> {
    // 1. Live categories & streams with in-memory filtering for instant browsing
    if (action === 'get_live_categories') {
        return sharedXtreamCache.getOrFetch(`upstream:live_cats:${clean}`, async () => {
            return (await fetchXtreamJson<unknown>(targetUrl)) ?? [];
        });
    }

    if (action === 'get_live_streams') {
        const allLive = await sharedXtreamCache.getOrFetch<Array<Record<string, unknown>>>(
            `upstream:live_streams:${clean}`,
            async () => {
                const urlWithoutCat = targetUrl.replace(/&category_id=[^&]*/, '');
                const data = await fetchXtreamJson<Array<Record<string, unknown>>>(urlWithoutCat);
                if (Array.isArray(data)) {
                    for (const item of data) {
                        if (item?.stream_id) {
                            sharedStreamCatalog.register({
                                id: item.stream_id as string | number,
                                type: 'live',
                                url: `${clean}/live/${u}/${p}/${item.stream_id}.ts`,
                                name: item.name as string,
                            });
                        }
                    }
                    return data;
                }
                return [];
            }
        );
        if (!Array.isArray(allLive)) return [];
        return categoryId ? allLive.filter((s) => String(s['category_id']) === categoryId) : allLive;
    }

    // 2. VOD categories, streams and movie details (get_vod_info)
    if (action === 'get_vod_categories') {
        return sharedXtreamCache.getOrFetch(`upstream:vod_cats:${clean}`, async () => {
            return (await fetchXtreamJson<unknown>(targetUrl)) ?? [];
        });
    }

    if (action === 'get_vod_streams') {
        const allVod = await sharedXtreamCache.getOrFetch<Array<Record<string, unknown>>>(
            `upstream:vod_streams:${clean}`,
            async () => {
                const urlWithoutCat = targetUrl.replace(/&category_id=[^&]*/, '');
                const data = await fetchXtreamJson<Array<Record<string, unknown>>>(urlWithoutCat);
                if (Array.isArray(data)) {
                    for (const item of data) {
                        if (item?.stream_id) {
                            const ext = (item['container_extension'] as string) || 'mp4';
                            sharedStreamCatalog.register({
                                id: item.stream_id as string | number,
                                type: 'movie',
                                url: `${clean}/movie/${u}/${p}/${item.stream_id}.${ext}`,
                                name: item.name as string,
                            });
                        }
                    }
                    return data;
                }
                return [];
            }
        );
        if (!Array.isArray(allVod)) return [];
        return categoryId ? allVod.filter((s) => String(s['category_id']) === categoryId) : allVod;
    }

    if (action === 'get_vod_info') {
        const cacheKey = `upstream:vod_info:${clean}:${vodId}`;
        const data = await sharedXtreamCache.getOrFetch<Record<string, unknown> | null>(cacheKey, async () => {
            return fetchXtreamJson<Record<string, unknown>>(targetUrl);
        });
        if (data && typeof data === 'object') return data;
    }

    // 3. Series categories, series list and series info
    if (action === 'get_series_categories') {
        return sharedXtreamCache.getOrFetch(`upstream:series_cats:${clean}`, async () => {
            return (await fetchXtreamJson<unknown>(targetUrl)) ?? [];
        });
    }

    if (action === 'get_series') {
        const allSeries = await sharedXtreamCache.getOrFetch<Array<Record<string, unknown>>>(
            `upstream:series:${clean}`,
            async () => {
                const urlWithoutCat = targetUrl.replace(/&category_id=[^&]*/, '');
                return (await fetchXtreamJson<Array<Record<string, unknown>>>(urlWithoutCat)) ?? [];
            }
        );
        if (!Array.isArray(allSeries)) return [];
        return categoryId ? allSeries.filter((s) => String(s['category_id']) === categoryId) : allSeries;
    }

    if (action === 'get_series_info') {
        const data = await fetchXtreamJson<Record<string, unknown>>(targetUrl);
        if (data && typeof data === 'object') {
            registerSeriesEpisodes(data, clean, u, p);
            return data;
        }
    }

    return fetchXtreamJson<unknown>(targetUrl);
}

function registerSeriesEpisodes(data: Record<string, unknown>, clean: string, u: string, p: string): void {
    const episodes = data['episodes'] as Record<string, Array<{ id?: number | string; container_extension?: string; title?: string }>> | undefined;
    if (!episodes) return;
    for (const epList of Object.values(episodes)) {
        if (!Array.isArray(epList)) continue;
        for (const ep of epList) {
            if (ep?.id) {
                const ext = ep.container_extension || 'mp4';
                sharedStreamCatalog.register({
                    id: ep.id,
                    type: 'series',
                    url: `${clean}/series/${u}/${p}/${ep.id}.${ext}`,
                    name: ep.title,
                });
            }
        }
    }
}

function handleLocalXtreamAction(
    action: string,
    playlists: Array<Record<string, unknown>>,
    categoryId: string,
    seriesId: string,
    vodId: string
): unknown {
    const cacheKey = `local_catalog:${playlists.map((p) => `${String(p['_id'] ?? p['id'] ?? '')}:${String((p['playlist'] as { items?: unknown[] })?.items?.length ?? p['count'] ?? 0)}`).join(';')}`;
    let catalog = sharedXtreamCache.get<LocalXtreamData>(cacheKey);
    if (!catalog) {
        catalog = buildLocalXtreamCatalog(playlists);
        sharedXtreamCache.set(cacheKey, catalog, 60000);
    }

    if (action === 'get_live_categories') return catalog.liveCategories;
    if (action === 'get_live_streams') {
        if (catalog.liveStreams.length === 0) {
            return [{
                num: 1,
                name: 'IPTVnator (No Playlists - Sync in Settings)',
                stream_type: 'live',
                stream_id: 9999,
                stream_icon: '',
                epg_channel_id: '',
                added: '1600000000',
                category_id: '1',
                custom_sid: '',
                tv_archive: 0,
                direct_source: '',
            }];
        }
        return categoryId ? catalog.liveStreams.filter((s) => String(s['category_id']) === categoryId) : catalog.liveStreams;
    }
    if (action === 'get_vod_categories') return catalog.vodCategories;
    if (action === 'get_vod_streams') {
        return categoryId ? catalog.vodStreams.filter((s) => String(s['category_id']) === categoryId) : catalog.vodStreams;
    }
    if (action === 'get_vod_info') {
        const movie = catalog.vodMap.get(vodId);
        return buildVodInfoResponse(movie, vodId);
    }
    if (action === 'get_series_categories') return catalog.seriesCategories;
    if (action === 'get_series') {
        return categoryId ? catalog.seriesList.filter((s) => String(s['category_id']) === categoryId) : catalog.seriesList;
    }
    if (action === 'get_series_info') {
        return buildSeriesInfoResponse(catalog, seriesId);
    }
    if (action === 'get_short_epg') return { epg_listings: [] };
    return [];
}
