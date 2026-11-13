/**
 * M3U Export Router
 *
 * Exposes endpoints allowing external IPTV players (TiviMate, IPTV Smarters,
 * VLC, Kodi, Smart TVs) to connect to IPTVnator and retrieve playlists where
 * all video/audio streams are automatically rewritten to route through the
 * VPS server stream proxy.
 *
 * Endpoints:
 *   1. GET /m3u/:id
 *      Exports a specific playlist by ID as a standard Extended M3U (#EXTM3U).
 *      Query params:
 *        - token=<string>  (optional/required if IPTVNATOR_ACCESS_TOKEN or UI password is set)
 *
 *   2. GET /m3u
 *      Exports all stored playlists merged into a single M3U playlist.
 *
 * Each channel item has its stream URL rewritten to:
 *   http://<host>/api/stream-proxy?url=<encoded_stream_url>
 */

import { Router, Request, Response } from 'express';
import type { ServerStorage } from './storage/server-storage';
import { legacySourceDocument } from './storage/legacy-source-document';
import { streamXtreamM3u } from './m3u-export-xtream';

export function createM3uExportRouter(
    storage: ServerStorage | null,
    accessToken: string | null,
    uiPassword?: string | null
): Router {
    const router = Router();

    // Middleware to validate token if set via query param or Authorization header
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

    const exportHandler = async (req: Request, res: Response) => {
        if (!storage) {
            res.status(503).send('#EXTM3U\n# Error: Server storage is disabled\n');
            return;
        }

        const effectiveToken = extractRequestToken(req) || accessToken || uiPassword || null;

        const rawId = req.params['id'];
        if (rawId) {
            const playlistId = (Array.isArray(rawId) ? rawId[0] : rawId).replace(/\.m3u8?$/i, '');
            const doc = storage.playlists.get(playlistId);
            if (!doc) {
                res.status(404).send('#EXTM3U\n# Error: Playlist not found\n');
                return;
            }

            const legacy = legacySourceDocument(doc) as Record<string, unknown>;
            const title = typeof legacy['title'] === 'string' ? legacy['title'] : 'playlist';

            res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(title)}.m3u"`);

            await streamM3uPlaylists([legacy], req, res, effectiveToken);
            return;
        }

        const allPlaylists = storage.playlists
            .listAll()
            .map((doc) => legacySourceDocument(doc) as Record<string, unknown>);

        res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="iptvnator-all.m3u"');

        await streamM3uPlaylists(allPlaylists, req, res, effectiveToken);
    };

    router.get('/m3u/:id', checkAuth, exportHandler);
    router.get('/m3u/:id.m3u', checkAuth, exportHandler);
    router.get('/m3u', checkAuth, exportHandler);
    router.get('/m3u.m3u', checkAuth, exportHandler);
    router.get('/playlist.m3u', checkAuth, exportHandler);

    return router;
}

async function streamM3uPlaylists(
    playlists: Array<Record<string, unknown>>,
    req: Request,
    res: Response,
    serverToken: string | null
): Promise<void> {
    const proxyBase = getProxyBaseUrl(req);
    const proxyQuery = typeof req.query['proxy'] === 'string' ? req.query['proxy'].trim().toLowerCase() : '';
    const useProxy = proxyQuery !== '0' && proxyQuery !== 'false' && proxyQuery !== 'no';
    res.write('#EXTM3U\n');

    for (const p of playlists) {
        // Xtream Codes portal source
        if (p['serverUrl'] && p['username'] && p['password']) {
            const serverUrl = String(p['serverUrl']).replace(/\/+$/, '');
            const username = String(p['username']);
            const password = String(p['password']);
            const outputFormat =
                typeof req.query['output'] === 'string' && req.query['output'].trim()
                    ? req.query['output'].trim()
                    : '';
            const streamType =
                typeof req.query['stream_type'] === 'string' && req.query['stream_type'].trim()
                    ? req.query['stream_type'].trim()
                    : '';

            await streamXtreamM3u(
                serverUrl,
                username,
                password,
                outputFormat,
                streamType,
                proxyBase,
                serverToken,
                res,
                useProxy
            );
            continue;
        }

        // Standard M3U playlist with parsed items
        const playlistObj = p['playlist'] as Record<string, unknown> | undefined;
        const items = (playlistObj?.['items'] || p['items'] || []) as Array<Record<string, unknown>>;
        const playlistTitle = (p['title'] as string) || 'IPTV';

        for (const item of items) {
            const rawUrl = (item['url'] as string) || '';
            if (!rawUrl) continue;

            const isMovie =
                rawUrl.includes('/movie/') ||
                rawUrl.includes('/vod/') ||
                /\.(mp4|mkv|avi)(\?|$)/i.test(rawUrl);
            const isSeries = rawUrl.includes('/series/');

            if (streamType === 'live' && (isMovie || isSeries)) continue;
            if ((streamType === 'movie' || streamType === 'vod' || streamType === 'movies') && !isMovie) continue;
            if ((streamType === 'series' || streamType === 'tvshows' || streamType === 'tv') && !isSeries) continue;

            const name = (item['name'] as string) || 'Channel';
            const tvg = (item['tvg'] as Record<string, string>) || {};
            const group = (item['group'] as Record<string, string>) || {};
            const groupTitle = group['title'] || playlistTitle;
            const tvgId = tvg['id'] || '';
            const tvgName = tvg['name'] || name;
            const tvgLogo = tvg['logo'] || '';

            const extinfParts = ['#EXTINF:-1'];
            if (tvgId) extinfParts.push(`tvg-id="${escapeAttr(tvgId)}"`);
            if (tvgName) extinfParts.push(`tvg-name="${escapeAttr(tvgName)}"`);
            if (tvgLogo) extinfParts.push(`tvg-logo="${escapeAttr(tvgLogo)}"`);
            if (groupTitle) extinfParts.push(`group-title="${escapeAttr(groupTitle)}"`);

            const typeAttr = isMovie
                ? 'tvg-type="movies" type="movies"'
                : isSeries
                  ? 'tvg-type="tvshows" type="tvshows"'
                  : 'tvg-type="live"';
            extinfParts.push(typeAttr);

            let streamUrl = rawUrl;
            if (useProxy) {
                streamUrl = `${proxyBase}/stream-proxy?url=${encodeURIComponent(rawUrl)}`;
                if (serverToken) {
                    streamUrl += `&token=${encodeURIComponent(serverToken)}`;
                }
            }

            res.write(`${extinfParts.join(' ')},${name}\n${streamUrl}\n`);
        }
    }

    res.end();
}

function getProxyBaseUrl(req: Request): string {
    const rawProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const protoStr = Array.isArray(rawProto) ? rawProto[0] : String(rawProto);
    const proto = protoStr.split(',')[0].trim() || 'http';

    const rawHost = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const hostStr = Array.isArray(rawHost) ? rawHost[0] : String(rawHost);
    const host = hostStr.split(',')[0].trim() || 'localhost';

    return `${proto}://${host}/api`;
}

function escapeAttr(val: string): string {
    return val.replace(/"/g, "'");
}

function extractRequestToken(req: Request): string {
    const query = req.query;
    const fromQuery =
        (typeof query['token'] === 'string' ? query['token'] : '') ||
        (typeof query['access_token'] === 'string' ? query['access_token'] : '') ||
        (typeof query['auth'] === 'string' ? query['auth'] : '') ||
        (typeof query['key'] === 'string' ? query['key'] : '') ||
        (typeof query['password'] === 'string' ? query['password'] : '') ||
        (typeof query['pass'] === 'string' ? query['pass'] : '');

    if (fromQuery.trim()) {
        return fromQuery.trim();
    }

    const authHeader = req.headers.authorization;
    if (authHeader) {
        if (authHeader.startsWith('Bearer ')) {
            return authHeader.slice(7).trim();
        }
        if (authHeader.startsWith('Basic ')) {
            try {
                const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
                const parts = decoded.split(':');
                return parts[1]?.trim() || parts[0]?.trim() || '';
            } catch {
                // Ignore decoding failure
            }
        }
    }

    return '';
}
