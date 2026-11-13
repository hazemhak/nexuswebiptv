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
import {
    detectContentType,
    formatCategory,
    parseSeriesEpisode,
    formatMovieTitle,
    fetchXtreamJson,
} from './m3u-export-classifier';
import { sharedStreamCatalog } from './stream-catalog-service';

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
            let targetUrl = `${clean}/player_api.php?username=${u}&password=${p}&action=${encodeURIComponent(action)}`;
            if (categoryId) targetUrl += `&category_id=${encodeURIComponent(categoryId)}`;
            if (seriesId) targetUrl += `&series_id=${encodeURIComponent(seriesId)}`;

            const data = await fetchXtreamJson<unknown>(targetUrl);
            if (data !== null) {
                registerUpstreamStreams(action, data, clean, u, p);
                res.json(data);
                return;
            }
        }

        // Handle catalog from stored M3U / local playlists
        res.json(handleLocalXtreamAction(action, playlists, categoryId, seriesId));
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

function buildUserInfo(username: string, password: string) {
    return {
        username: username || 'admin',
        password: password || '',
        message: 'Connected to IPTVnator Xtream Codes API',
        auth: 1,
        status: 'Active',
        exp_date: '1893456000',
        is_trial: '0',
        active_cons: '1',
        created_at: '1600000000',
        max_connections: '5',
        allowed_output_formats: ['m3u8', 'ts', 'mp4', 'mkv'],
    };
}

function buildServerInfo(req: Request) {
    const rawProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const proto = (Array.isArray(rawProto) ? rawProto[0] : String(rawProto)).split(',')[0].trim() || 'http';
    const rawHost = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const hostWithPort = (Array.isArray(rawHost) ? rawHost[0] : String(rawHost)).split(',')[0].trim() || 'localhost';
    const [host, portPart] = hostWithPort.split(':');
    const port = portPart || (proto === 'https' ? '443' : '80');
    const now = new Date();

    return {
        url: host,
        port: port,
        https_port: proto === 'https' ? port : '443',
        server_protocol: proto,
        rtmp_port: port,
        timezone: 'UTC',
        timestamp_now: Math.floor(now.getTime() / 1000),
        time_now: now.toISOString().replace('T', ' ').slice(0, 19),
    };
}

function registerUpstreamStreams(action: string, data: unknown, clean: string, u: string, p: string): void {
    if (action === 'get_live_streams' && Array.isArray(data)) {
        for (const item of data) {
            if (item?.stream_id) {
                sharedStreamCatalog.register({
                    id: item.stream_id,
                    type: 'live',
                    url: `${clean}/live/${u}/${p}/${item.stream_id}.ts`,
                    name: item.name,
                });
            }
        }
    } else if (action === 'get_vod_streams' && Array.isArray(data)) {
        for (const item of data) {
            if (item?.stream_id) {
                const ext = item.container_extension || 'mp4';
                sharedStreamCatalog.register({
                    id: item.stream_id,
                    type: 'movie',
                    url: `${clean}/movie/${u}/${p}/${item.stream_id}.${ext}`,
                    name: item.name,
                });
            }
        }
    } else if (action === 'get_series_info' && data && typeof data === 'object') {
        const episodes = (data as Record<string, unknown>)['episodes'] as Record<string, Array<{ id?: number | string; container_extension?: string; title?: string }>> | undefined;
        if (episodes) {
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
    }
}

function handleLocalXtreamAction(
    action: string,
    playlists: Array<Record<string, unknown>>,
    categoryId: string,
    seriesId: string
): unknown {
    const categoriesMap = new Map<string, { id: string; name: string }>();
    const liveStreams: Array<Record<string, unknown>> = [];
    const vodStreams: Array<Record<string, unknown>> = [];
    const seriesList: Array<Record<string, unknown>> = [];
    const seriesEpisodesMap = new Map<string, Array<Record<string, unknown>>>();

    let catCounter = 1;
    const getCatId = (name: string): string => {
        let cat = categoriesMap.get(name);
        if (!cat) {
            cat = { id: String(catCounter++), name };
            categoriesMap.set(name, cat);
        }
        return cat.id;
    };

    let streamIdCounter = 1000;
    for (const p of playlists) {
        const pObj = p['playlist'] as Record<string, unknown> | undefined;
        const items = (pObj?.['items'] || p['items'] || []) as Array<Record<string, unknown>>;
        const playlistTitle = (p['title'] as string) || 'IPTV';

        for (const item of items) {
            const rawUrl = (item['url'] as string) || '';
            if (!rawUrl) continue;
            const name = (item['name'] as string) || 'Channel';
            const tvg = (item['tvg'] as Record<string, string>) || {};
            const group = (item['group'] as Record<string, string>) || {};
            const rawGroup = group['title'] || playlistTitle;
            const contentType = detectContentType(rawUrl, name, rawGroup);
            const groupTitle = formatCategory(rawGroup, contentType);
            const catId = getCatId(groupTitle);
            const streamId = ++streamIdCounter;

            sharedStreamCatalog.register({ id: streamId, type: contentType, url: rawUrl, name });

            if (contentType === 'live') {
                liveStreams.push({
                    num: liveStreams.length + 1,
                    name,
                    stream_type: 'live',
                    stream_id: streamId,
                    stream_icon: tvg['logo'] || '',
                    epg_channel_id: tvg['id'] || '',
                    added: '1600000000',
                    category_id: catId,
                    custom_sid: '',
                    tv_archive: 0,
                    direct_source: '',
                });
            } else if (contentType === 'movie') {
                vodStreams.push({
                    num: vodStreams.length + 1,
                    name: formatMovieTitle(name),
                    stream_type: 'movie',
                    stream_id: streamId,
                    stream_icon: tvg['logo'] || '',
                    rating: '8.0',
                    rating_5based: 4.0,
                    added: '1600000000',
                    category_id: catId,
                    container_extension: 'mp4',
                    custom_sid: '',
                    direct_source: '',
                });
            } else if (contentType === 'series') {
                const parsed = parseSeriesEpisode(name, rawGroup);
                let series = seriesList.find((s) => s['name'] === parsed.seriesTitle);
                if (!series) {
                    const sid = String(seriesList.length + 1);
                    series = {
                        num: seriesList.length + 1,
                        name: parsed.seriesTitle,
                        series_id: sid,
                        cover: tvg['logo'] || '',
                        plot: '',
                        cast: '',
                        director: '',
                        genre: groupTitle,
                        releaseDate: '',
                        last_modified: '1600000000',
                        rating: '8.0',
                        rating_5based: 4.0,
                        category_id: catId,
                    };
                    seriesList.push(series);
                    seriesEpisodesMap.set(sid, []);
                }
                const sid = String(series['series_id']);
                seriesEpisodesMap.get(sid)?.push({
                    id: streamId,
                    episode_num: parsed.episode,
                    title: parsed.displayTitle,
                    container_extension: 'mp4',
                    info: { duration_secs: 3600, duration: '01:00:00', bitrate: 0 },
                    custom_sid: '',
                    added: '1600000000',
                    season: parsed.season,
                });
            }
        }
    }

    if (action === 'get_live_categories') {
        return Array.from(categoriesMap.values()).map((c) => ({
            category_id: c.id,
            category_name: c.name,
            parent_id: 0,
        }));
    }
    if (action === 'get_live_streams') {
        if (liveStreams.length === 0) {
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
        return categoryId ? liveStreams.filter((s) => String(s['category_id']) === categoryId) : liveStreams;
    }
    if (action === 'get_vod_categories') {
        return Array.from(categoriesMap.values()).map((c) => ({
            category_id: c.id,
            category_name: c.name,
            parent_id: 0,
        }));
    }
    if (action === 'get_vod_streams') {
        return categoryId ? vodStreams.filter((s) => String(s['category_id']) === categoryId) : vodStreams;
    }
    if (action === 'get_series_categories') {
        return Array.from(categoriesMap.values()).map((c) => ({
            category_id: c.id,
            category_name: c.name,
            parent_id: 0,
        }));
    }
    if (action === 'get_series') {
        return categoryId ? seriesList.filter((s) => String(s['category_id']) === categoryId) : seriesList;
    }
    if (action === 'get_series_info') {
        const series = seriesList.find((s) => String(s['series_id']) === seriesId);
        const epList = seriesEpisodesMap.get(seriesId) || [];
        const seasonsMap = new Map<number, number>();
        const episodesObj: Record<string, Array<Record<string, unknown>>> = {};

        for (const ep of epList) {
            const season = Number(ep['season']) || 1;
            seasonsMap.set(season, (seasonsMap.get(season) || 0) + 1);
            if (!episodesObj[String(season)]) episodesObj[String(season)] = [];
            episodesObj[String(season)].push(ep);
        }

        const seasons = Array.from(seasonsMap.entries()).map(([seasonNum, count]) => ({
            air_date: '',
            episode_count: count,
            id: seasonNum,
            name: `Season ${seasonNum}`,
            overview: '',
            season_number: seasonNum,
            cover: series ? String(series['cover']) : '',
        }));

        return {
            seasons,
            info: series || {},
            episodes: episodesObj,
        };
    }
    if (action === 'get_short_epg') return { epg_listings: [] };
    return [];
}
