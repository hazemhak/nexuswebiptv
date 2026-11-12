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
 *        - token=<string>  (optional/required if IPTVNATOR_ACCESS_TOKEN is set)
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

export function createM3uExportRouter(
    storage: ServerStorage | null,
    accessToken: string | null
): Router {
    const router = Router();

    // Middleware to validate accessToken if set via query param or Authorization header
    const checkAuth = (req: Request, res: Response, next: () => void) => {
        if (!accessToken) {
            return next();
        }
        const queryToken = typeof req.query['token'] === 'string' ? req.query['token'].trim() : '';
        const authHeader = req.headers.authorization;
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

        if (queryToken === accessToken || bearerToken === accessToken) {
            return next();
        }

        res.status(401).send('#EXTM3U\n# Unauthorized: Invalid or missing access token\n');
    };

    router.get('/m3u/:id', checkAuth, (req, res) => {
        if (!storage) {
            res.status(503).send('#EXTM3U\n# Error: Server storage is disabled\n');
            return;
        }

        const rawId = req.params.id;
        const playlistId = Array.isArray(rawId) ? rawId[0] : rawId;
        const doc = storage.playlists.get(playlistId);
        if (!doc) {
            res.status(404).send('#EXTM3U\n# Error: Playlist not found\n');
            return;
        }

        const legacy = legacySourceDocument(doc) as Record<string, unknown>;
        const m3uContent = buildM3uPlaylist([legacy], req, accessToken);
        const title = typeof legacy['title'] === 'string' ? legacy['title'] : 'playlist';

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(title)}.m3u"`);
        res.send(m3uContent);
    });

    router.get('/m3u', checkAuth, (req, res) => {
        if (!storage) {
            res.status(503).send('#EXTM3U\n# Error: Server storage is disabled\n');
            return;
        }

        const allPlaylists = storage.playlists
            .listAll()
            .map((doc) => legacySourceDocument(doc) as Record<string, unknown>);
        const m3uContent = buildM3uPlaylist(allPlaylists, req, accessToken);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="iptvnator-all.m3u"');
        res.send(m3uContent);
    });

    return router;
}

function buildM3uPlaylist(
    playlists: Array<Record<string, unknown>>,
    req: Request,
    serverToken: string | null
): string {
    const proxyBase = getProxyBaseUrl(req);
    const lines: string[] = ['#EXTM3U'];

    for (const p of playlists) {
        const playlistObj = p['playlist'] as Record<string, unknown> | undefined;
        const items = (playlistObj?.['items'] || p['items'] || []) as Array<Record<string, unknown>>;
        const playlistTitle = (p['title'] as string) || 'IPTV';

        for (const item of items) {
            const rawUrl = (item['url'] as string) || '';
            if (!rawUrl) continue;

            const name = (item['name'] as string) || 'Channel';
            const tvg = (item['tvg'] as Record<string, string>) || {};
            const group = (item['group'] as Record<string, string>) || {};
            const groupTitle = group['title'] || playlistTitle;
            const tvgId = tvg['id'] || '';
            const tvgName = tvg['name'] || name;
            const tvgLogo = tvg['logo'] || '';

            // Format #EXTINF line with standard IPTV metadata attributes
            const extinfParts = ['#EXTINF:-1'];
            if (tvgId) extinfParts.push(`tvg-id="${escapeAttr(tvgId)}"`);
            if (tvgName) extinfParts.push(`tvg-name="${escapeAttr(tvgName)}"`);
            if (tvgLogo) extinfParts.push(`tvg-logo="${escapeAttr(tvgLogo)}"`);
            if (groupTitle) extinfParts.push(`group-title="${escapeAttr(groupTitle)}"`);

            lines.push(`${extinfParts.join(' ')},${name}`);

            // Proxy the stream URL through our server
            let proxiedUrl = `${proxyBase}/stream-proxy?url=${encodeURIComponent(rawUrl)}`;
            // If the server requires a token, append it to the proxied stream if necessary
            if (serverToken) {
                proxiedUrl += `&token=${encodeURIComponent(serverToken)}`;
            }

            lines.push(proxiedUrl);
        }
    }

    return lines.join('\n') + '\n';
}

function getProxyBaseUrl(req: Request): string {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    return `${proto}://${host}/api`;
}

function escapeAttr(val: string): string {
    return val.replace(/"/g, "'");
}
