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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import * as readline from 'node:readline';
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

        const providedToken = extractRequestToken(req);
        if (providedToken === accessToken) {
            return next();
        }

        res.status(401).send('#EXTM3U\n# Unauthorized: Invalid or missing access token\n');
    };

    router.get('/m3u/:id', checkAuth, async (req, res) => {
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
        const title = typeof legacy['title'] === 'string' ? legacy['title'] : 'playlist';

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(title)}.m3u"`);

        await streamM3uPlaylists([legacy], req, res, accessToken);
    });

    router.get('/m3u', checkAuth, async (req, res) => {
        if (!storage) {
            res.status(503).send('#EXTM3U\n# Error: Server storage is disabled\n');
            return;
        }

        const allPlaylists = storage.playlists
            .listAll()
            .map((doc) => legacySourceDocument(doc) as Record<string, unknown>);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="iptvnator-all.m3u"');

        await streamM3uPlaylists(allPlaylists, req, res, accessToken);
    });

    return router;
}

async function streamM3uPlaylists(
    playlists: Array<Record<string, unknown>>,
    req: Request,
    res: Response,
    serverToken: string | null
): Promise<void> {
    const proxyBase = getProxyBaseUrl(req);
    res.write('#EXTM3U\n');

    for (const p of playlists) {
        // Xtream Codes portal source
        if (p['serverUrl'] && p['username'] && p['password']) {
            const serverUrl = String(p['serverUrl']).replace(/\/+$/, '');
            const username = String(p['username']);
            const password = String(p['password']);
            const xtreamUrl = `${serverUrl}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=m3u8`;
            await streamXtreamM3u(xtreamUrl, proxyBase, serverToken, res);
            continue;
        }

        // Standard M3U playlist with parsed items
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

            const extinfParts = ['#EXTINF:-1'];
            if (tvgId) extinfParts.push(`tvg-id="${escapeAttr(tvgId)}"`);
            if (tvgName) extinfParts.push(`tvg-name="${escapeAttr(tvgName)}"`);
            if (tvgLogo) extinfParts.push(`tvg-logo="${escapeAttr(tvgLogo)}"`);
            if (groupTitle) extinfParts.push(`group-title="${escapeAttr(groupTitle)}"`);

            let proxiedUrl = `${proxyBase}/stream-proxy?url=${encodeURIComponent(rawUrl)}`;
            if (serverToken) {
                proxiedUrl += `&token=${encodeURIComponent(serverToken)}`;
            }

            res.write(`${extinfParts.join(' ')},${name}\n${proxiedUrl}\n`);
        }
    }

    res.end();
}

function streamXtreamM3u(
    targetUrl: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response,
    hopCount = 0
): Promise<void> {
    if (hopCount > 5) return Promise.resolve();

    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL(targetUrl);
        } catch {
            return resolve();
        }

        const makeRequest = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = makeRequest(
            targetUrl,
            {
                headers: {
                    'User-Agent': 'IPTVSmarters/2.2.2.1',
                    Accept: '*/*',
                },
                timeout: 30000,
            },
            (upstream) => {
                const status = upstream.statusCode ?? 200;
                if (status >= 300 && status < 400 && upstream.headers.location) {
                    upstream.resume();
                    const redirectUrl = new URL(upstream.headers.location, targetUrl).href;
                    return resolve(streamXtreamM3u(redirectUrl, proxyBase, serverToken, res, hopCount + 1));
                }

                if (status !== 200) {
                    upstream.resume();
                    return resolve();
                }

                const rl = readline.createInterface({ input: upstream, crlfDelay: Infinity });
                rl.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === '#EXTM3U') return;

                    if (trimmed.startsWith('#')) {
                        res.write(trimmed + '\n');
                    } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                        let proxied = `${proxyBase}/stream-proxy?url=${encodeURIComponent(trimmed)}`;
                        if (serverToken) {
                            proxied += `&token=${encodeURIComponent(serverToken)}`;
                        }
                        res.write(proxied + '\n');
                    }
                });

                rl.on('close', resolve);
                upstream.on('error', resolve);
            }
        );

        req.on('error', resolve);
        req.on('timeout', () => {
            req.destroy();
            resolve();
        });
        req.end();
    });
}

function getProxyBaseUrl(req: Request): string {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
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
