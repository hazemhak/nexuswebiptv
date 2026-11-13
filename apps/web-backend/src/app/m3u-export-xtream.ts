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
    const userEnc = encodeURIComponent(username);
    const passEnc = encodeURIComponent(password);

    if (streamType === 'movie' || streamType === 'vod') {
        await streamMovies(cleanServer, username, password, outputFormat, proxyBase, serverToken, res);
        return;
    }
    if (streamType === 'series') {
        await streamSeries(cleanServer, userEnc, passEnc, outputFormat, proxyBase, serverToken, res);
        return;
    }
    if (streamType === 'live') {
        let liveUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus&stream_type=live`;
        if (outputFormat) liveUrl += `&output=${encodeURIComponent(outputFormat)}`;
        await streamM3uFromUrl(liveUrl, cleanServer, proxyBase, serverToken, res);
        return;
    }

    // Default: export Live TV, then Movies, then Series
    let baseLiveUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus`;
    if (outputFormat) baseLiveUrl += `&output=${encodeURIComponent(outputFormat)}`;
    const { vodCount, seriesCount } = await streamM3uFromUrl(
        baseLiveUrl,
        cleanServer,
        proxyBase,
        serverToken,
        res
    );

    // If get.php only returned live channels, explicitly stream movies
    if (vodCount === 0) {
        await streamMovies(cleanServer, username, password, outputFormat, proxyBase, serverToken, res);
    }

    // If get.php only returned live channels, explicitly stream series
    if (seriesCount === 0) {
        await streamSeries(cleanServer, userEnc, passEnc, outputFormat, proxyBase, serverToken, res);
    }
}

async function streamMovies(
    cleanServer: string,
    username: string,
    password: string,
    outputFormat: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response
): Promise<void> {
    const userEnc = encodeURIComponent(username);
    const passEnc = encodeURIComponent(password);

    // 1. Try get.php with stream_type=movie
    let movieUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus&stream_type=movie`;
    if (outputFormat) movieUrl += `&output=${encodeURIComponent(outputFormat)}`;
    let { streamCount } = await streamM3uFromUrl(movieUrl, cleanServer, proxyBase, serverToken, res);

    // 2. Try get.php with stream_type=vod
    if (streamCount === 0) {
        let vodUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus&stream_type=vod`;
        if (outputFormat) vodUrl += `&output=${encodeURIComponent(outputFormat)}`;
        const res2 = await streamM3uFromUrl(vodUrl, cleanServer, proxyBase, serverToken, res);
        streamCount = res2.streamCount;
    }

    // 3. Fallback: player_api.php?action=get_vod_streams
    if (streamCount === 0) {
        const apiUrl = `${cleanServer}/player_api.php?username=${userEnc}&password=${passEnc}&action=get_vod_streams`;
        const vodStreams = await fetchXtreamJson<Array<{
            name?: string;
            stream_id?: number | string;
            stream_icon?: string;
            container_extension?: string;
            category_id?: string | number;
        }>>(apiUrl);

        if (Array.isArray(vodStreams)) {
            for (const item of vodStreams) {
                if (!item || !item.stream_id) continue;
                const name = item.name || `Movie ${item.stream_id}`;
                const ext = item.container_extension || 'mp4';
                const logo = item.stream_icon || '';
                const movieStreamUrl = `${cleanServer}/movie/${userEnc}/${passEnc}/${item.stream_id}.${ext}`;
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

async function streamSeries(
    cleanServer: string,
    userEnc: string,
    passEnc: string,
    outputFormat: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response
): Promise<void> {
    let seriesUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus&stream_type=series`;
    if (outputFormat) seriesUrl += `&output=${encodeURIComponent(outputFormat)}`;
    const { streamCount } = await streamM3uFromUrl(seriesUrl, cleanServer, proxyBase, serverToken, res);

    if (streamCount === 0) {
        let tvUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus&stream_type=tv`;
        if (outputFormat) tvUrl += `&output=${encodeURIComponent(outputFormat)}`;
        await streamM3uFromUrl(tvUrl, cleanServer, proxyBase, serverToken, res);
    }
}

function streamM3uFromUrl(
    targetUrl: string,
    cleanServer: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response,
    hopCount = 0
): Promise<{ streamCount: number; vodCount: number; seriesCount: number }> {
    if (hopCount > 5) return Promise.resolve({ streamCount: 0, vodCount: 0, seriesCount: 0 });

    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL(targetUrl);
        } catch {
            return resolve({ streamCount: 0, vodCount: 0, seriesCount: 0 });
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
                    return resolve({ streamCount: 0, vodCount: 0, seriesCount: 0 });
                }

                let streamCount = 0;
                let vodCount = 0;
                let seriesCount = 0;

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
                        if (
                            fullUrl.includes('/movie/') ||
                            fullUrl.includes('/vod/') ||
                            /\.(mp4|mkv|avi)(\?|$)/i.test(fullUrl)
                        ) {
                            vodCount++;
                        } else if (fullUrl.includes('/series/')) {
                            seriesCount++;
                        }
                        let proxied = `${proxyBase}/stream-proxy?url=${encodeURIComponent(fullUrl)}`;
                        if (serverToken) {
                            proxied += `&token=${encodeURIComponent(serverToken)}`;
                        }
                        res.write(proxied + '\n');
                    }
                });

                rl.on('close', () => resolve({ streamCount, vodCount, seriesCount }));
                upstream.on('error', () => resolve({ streamCount, vodCount, seriesCount }));
            }
        );

        req.on('error', () => resolve({ streamCount: 0, vodCount: 0, seriesCount: 0 }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ streamCount: 0, vodCount: 0, seriesCount: 0 });
        });
        req.end();
    });
}

function fetchXtreamJson<T>(targetUrl: string, hopCount = 0): Promise<T | null> {
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
                timeout: 20000,
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

function escapeAttr(val: string): string {
    return val.replace(/"/g, "'");
}
