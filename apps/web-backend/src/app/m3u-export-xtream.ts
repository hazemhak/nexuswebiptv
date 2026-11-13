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
        await streamMovies(cleanServer, userEnc, passEnc, proxyBase, serverToken, res);
        return;
    }
    if (streamType === 'series') {
        await streamSeries(cleanServer, userEnc, passEnc, proxyBase, serverToken, res);
        return;
    }
    if (streamType === 'live') {
        await streamLive(cleanServer, userEnc, passEnc, outputFormat, proxyBase, serverToken, res);
        return;
    }

    // Default: stream Live TV, then supplement with Movies and Series via Xtream JSON API
    const { vodCount, seriesCount } = await streamLive(
        cleanServer,
        userEnc,
        passEnc,
        outputFormat,
        proxyBase,
        serverToken,
        res
    );

    if (vodCount === 0 && !res.writableEnded) {
        await streamMovies(cleanServer, userEnc, passEnc, proxyBase, serverToken, res);
    }

    if (seriesCount === 0 && !res.writableEnded) {
        await streamSeries(cleanServer, userEnc, passEnc, proxyBase, serverToken, res);
    }
}

async function streamLive(
    cleanServer: string,
    userEnc: string,
    passEnc: string,
    outputFormat: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response
): Promise<{ streamCount: number; vodCount: number; seriesCount: number }> {
    let liveUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus`;
    if (outputFormat) liveUrl += `&output=${encodeURIComponent(outputFormat)}`;
    return streamM3uFromUrl(liveUrl, cleanServer, proxyBase, serverToken, res);
}

async function streamMovies(
    cleanServer: string,
    userEnc: string,
    passEnc: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response
): Promise<void> {
    const catUrl = `${cleanServer}/player_api.php?username=${userEnc}&password=${passEnc}&action=get_vod_categories`;
    const categories = await fetchXtreamJson<Array<{ category_id?: string | number; category_name?: string }>>(catUrl);
    const catMap = new Map<string, string>();
    if (Array.isArray(categories)) {
        for (const c of categories) {
            if (c?.category_id && c?.category_name) {
                catMap.set(String(c.category_id), c.category_name);
            }
        }
    }

    const apiUrl = `${cleanServer}/player_api.php?username=${userEnc}&password=${passEnc}&action=get_vod_streams`;
    const vodStreams = await fetchXtreamJson<Array<{
        name?: string;
        stream_id?: number | string;
        stream_icon?: string;
        container_extension?: string;
        category_id?: string | number;
    }>>(apiUrl);

    if (!Array.isArray(vodStreams)) return;
    const tokenParam = serverToken ? `&token=${encodeURIComponent(serverToken)}` : '';

    for (const item of vodStreams) {
        if (!item || !item.stream_id || res.writableEnded) continue;
        const name = item.name || `Movie ${item.stream_id}`;
        const ext = item.container_extension || 'mp4';
        const logo = item.stream_icon || '';
        const catName = (item.category_id && catMap.get(String(item.category_id))) || 'Movies';
        const movieStreamUrl = `${cleanServer}/movie/${userEnc}/${passEnc}/${item.stream_id}.${ext}`;
        const proxied = `${proxyBase}/stream-proxy/movie/${item.stream_id}.${ext}?url=${encodeURIComponent(movieStreamUrl)}${tokenParam}`;
        const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(name)}" tvg-logo="${escapeAttr(logo)}" group-title="${escapeAttr(catName)}" tvg-type="movie",${name}`;
        res.write(`${extinf}\n${proxied}\n`);
    }
}

async function streamSeries(
    cleanServer: string,
    userEnc: string,
    passEnc: string,
    proxyBase: string,
    serverToken: string | null,
    res: Response
): Promise<void> {
    const catUrl = `${cleanServer}/player_api.php?username=${userEnc}&password=${passEnc}&action=get_series_categories`;
    const categories = await fetchXtreamJson<Array<{ category_id?: string | number; category_name?: string }>>(catUrl);
    const catMap = new Map<string, string>();
    if (Array.isArray(categories)) {
        for (const c of categories) {
            if (c?.category_id && c?.category_name) {
                catMap.set(String(c.category_id), c.category_name);
            }
        }
    }

    const listUrl = `${cleanServer}/player_api.php?username=${userEnc}&password=${passEnc}&action=get_series`;
    const seriesList = await fetchXtreamJson<Array<{
        series_id?: number | string;
        name?: string;
        cover?: string;
        category_id?: string | number;
    }>>(listUrl);

    if (!Array.isArray(seriesList) || seriesList.length === 0) return;
    const tokenParam = serverToken ? `&token=${encodeURIComponent(serverToken)}` : '';

    const CONCURRENCY = 8;
    let nextIdx = 0;

    const worker = async () => {
        while (nextIdx < seriesList.length) {
            if (res.writableEnded || res.destroyed) break;
            const series = seriesList[nextIdx++];
            if (!series?.series_id) continue;

            const infoUrl = `${cleanServer}/player_api.php?username=${userEnc}&password=${passEnc}&action=get_series_info&series_id=${series.series_id}`;
            const info = await fetchXtreamJson<{
                episodes?: Record<string, Array<{
                    id?: string | number;
                    title?: string;
                    container_extension?: string;
                    season?: number | string;
                    episode_num?: number | string;
                }>>;
            }>(infoUrl);

            if (!info?.episodes || res.writableEnded || res.destroyed) continue;

            const seriesName = series.name || `Series ${series.series_id}`;
            const logo = series.cover || '';
            const catName = (series.category_id && catMap.get(String(series.category_id))) || seriesName;

            for (const [seasonKey, episodes] of Object.entries(info.episodes)) {
                if (!Array.isArray(episodes)) continue;
                for (const ep of episodes) {
                    if (!ep?.id || res.writableEnded) continue;
                    const ext = ep.container_extension || 'mp4';
                    const s = ep.season ?? seasonKey;
                    const e = ep.episode_num ?? '?';
                    const epTitle = ep.title
                        ? `${seriesName} S${s}E${e} - ${ep.title}`
                        : `${seriesName} S${s}E${e}`;
                    const epUrl = `${cleanServer}/series/${userEnc}/${passEnc}/${ep.id}.${ext}`;
                    const proxied = `${proxyBase}/stream-proxy/series/${ep.id}.${ext}?url=${encodeURIComponent(epUrl)}${tokenParam}`;
                    const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(epTitle)}" tvg-logo="${escapeAttr(logo)}" group-title="${escapeAttr(catName)}" tvg-type="series",${epTitle}`;
                    res.write(`${extinf}\n${proxied}\n`);
                }
            }
        }
    };

    const pool = Array.from({ length: Math.min(CONCURRENCY, seriesList.length) }, () => worker());
    await Promise.all(pool);
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
                const tokenParam = serverToken ? `&token=${encodeURIComponent(serverToken)}` : '';

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
                        const isVod =
                            fullUrl.includes('/movie/') ||
                            fullUrl.includes('/vod/') ||
                            /\.(mp4|mkv|avi)(\?|$)/i.test(fullUrl);
                        const isSeries = fullUrl.includes('/series/');

                        if (isVod) vodCount++;
                        else if (isSeries) seriesCount++;

                        const typePrefix = isVod ? 'movie/' : isSeries ? 'series/' : '';
                        const proxied = `${proxyBase}/stream-proxy/${typePrefix}?url=${encodeURIComponent(fullUrl)}${tokenParam}`.replace('/stream-proxy//', '/stream-proxy/');
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
                timeout: 15000,
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
