import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import * as readline from 'node:readline';
import type { Response } from 'express';

export async function streamXtreamM3u(
    serverUrl: string,
    username: string,
    password: string,
    outputFormat: string,
    streamType: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response
): Promise<void> {
    const cleanServer = serverUrl.replace(/\/+$/, '');
    let xtreamUrl = `${cleanServer}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus`;
    if (outputFormat) {
        xtreamUrl += `&output=${encodeURIComponent(outputFormat)}`;
    }
    if (streamType) {
        xtreamUrl += `&stream_type=${encodeURIComponent(streamType)}`;
    }

    const { vodOrSeriesCount } = await streamM3uFromUrl(
        xtreamUrl,
        cleanServer,
        proxyBase,
        serverToken,
        res
    );

    // If get.php returned only live channels (0 VOD/series), and the client
    // didn't explicitly request live-only, append movies via player_api.php:
    if (vodOrSeriesCount === 0 && streamType !== 'live') {
        const vodUrl = `${cleanServer}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_vod_streams`;
        const vodStreams = await fetchXtreamJson<Array<{
            name?: string;
            stream_id?: number | string;
            stream_icon?: string;
            container_extension?: string;
            category_id?: string | number;
        }>>(vodUrl);

        if (Array.isArray(vodStreams)) {
            for (const item of vodStreams) {
                if (!item || !item.stream_id) continue;
                const name = item.name || `Movie ${item.stream_id}`;
                const ext = item.container_extension || 'mp4';
                const logo = item.stream_icon || '';
                const movieStreamUrl = `${cleanServer}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${item.stream_id}.${ext}`;
                let proxied = `${proxyBase}/stream-proxy?url=${encodeURIComponent(movieStreamUrl)}`;
                if (serverToken) {
                    proxied += `&token=${encodeURIComponent(serverToken)}`;
                }
                const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(name)}" tvg-logo="${escapeAttr(logo)}" group-title="Movies",${name}`;
                res.write(`${extinf}\n${proxied}\n`);
            }
        }
    }
}

function streamM3uFromUrl(
    targetUrl: string,
    cleanServer: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response,
    hopCount = 0
): Promise<{ streamCount: number; vodOrSeriesCount: number }> {
    if (hopCount > 5) return Promise.resolve({ streamCount: 0, vodOrSeriesCount: 0 });

    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL(targetUrl);
        } catch {
            return resolve({ streamCount: 0, vodOrSeriesCount: 0 });
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
                    return resolve(streamM3uFromUrl(redirectUrl, cleanServer, proxyBase, serverToken, res, hopCount + 1));
                }

                if (status !== 200) {
                    upstream.resume();
                    return resolve({ streamCount: 0, vodOrSeriesCount: 0 });
                }

                let streamCount = 0;
                let vodOrSeriesCount = 0;

                const rl = readline.createInterface({ input: upstream, crlfDelay: Infinity });
                rl.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === '#EXTM3U') return;

                    if (trimmed.startsWith('#')) {
                        res.write(trimmed + '\n');
                    } else {
                        streamCount++;
                        let fullUrl = trimmed;
                        if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
                            try {
                                fullUrl = new URL(trimmed, targetUrl).href;
                            } catch {
                                fullUrl = `${cleanServer}/${trimmed.replace(/^\/+/, '')}`;
                            }
                        }
                        if (fullUrl.includes('/movie/') || fullUrl.includes('/series/')) {
                            vodOrSeriesCount++;
                        }
                        let proxied = `${proxyBase}/stream-proxy?url=${encodeURIComponent(fullUrl)}`;
                        if (serverToken) {
                            proxied += `&token=${encodeURIComponent(serverToken)}`;
                        }
                        res.write(proxied + '\n');
                    }
                });

                rl.on('close', () => resolve({ streamCount, vodOrSeriesCount }));
                upstream.on('error', () => resolve({ streamCount, vodOrSeriesCount }));
            }
        );

        req.on('error', () => resolve({ streamCount: 0, vodOrSeriesCount: 0 }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ streamCount: 0, vodOrSeriesCount: 0 });
        });
        req.end();
    });
}

function fetchXtreamJson<T>(targetUrl: string): Promise<T | null> {
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
            },
            (res) => {
                if ((res.statusCode ?? 0) !== 200) {
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

function escapeAttr(val: string): string {
    return val.replace(/"/g, "'");
}
