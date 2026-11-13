import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import * as readline from 'node:readline';
import type { Response } from 'express';
import {
    ExportContentType,
    M3uExportEntry,
    sortExportEntries,
    detectContentType,
    formatCategory,
    parseSeriesEpisode,
    formatMovieTitle,
    getStreamExtension,
    escapeAttr,
    buildProxiedStreamUrl,
    fetchXtreamJson,
} from './m3u-export-classifier';

export type { ExportContentType, M3uExportEntry };
export {
    detectContentType,
    formatCategory,
    parseSeriesEpisode,
    formatMovieTitle,
    getStreamExtension,
    escapeAttr,
    buildProxiedStreamUrl,
};

export async function streamXtreamM3u(
    serverUrl: string,
    username: string,
    password: string,
    outputFormat: string,
    streamType: string,
    hostBase: string,
    serverToken: string | null,
    res: Response,
    useProxy = true
): Promise<void> {
    const cleanServer = serverUrl.replace(/\/+$/, '');
    const userEnc = encodeURIComponent(username);
    const passEnc = encodeURIComponent(password);
    const tokenParam = serverToken ? `&token=${encodeURIComponent(serverToken)}` : '';

    const entries: M3uExportEntry[] = [];

    // 1. Fetch live / main M3U stream entries
    let liveUrl = `${cleanServer}/get.php?username=${userEnc}&password=${passEnc}&type=m3u_plus`;
    if (outputFormat) liveUrl += `&output=${encodeURIComponent(outputFormat)}`;

    const { vodCount, seriesCount } = await collectM3uFromUrl(
        liveUrl,
        cleanServer,
        hostBase,
        tokenParam,
        entries,
        useProxy,
        streamType
    );

    // 2. Fetch VOD / Movies if none were in the M3U and movies are requested
    const needVod = streamType !== 'live' && (vodCount === 0 || streamType === 'movie' || streamType === 'vod');
    if (needVod && !res.writableEnded) {
        await collectMovies(cleanServer, userEnc, passEnc, hostBase, tokenParam, entries, useProxy);
    }

    // 3. Fetch Series if none were in the M3U and series are requested
    const needSeries = streamType !== 'live' && (seriesCount === 0 || streamType === 'series');
    if (needSeries && !res.writableEnded) {
        await collectSeries(cleanServer, userEnc, passEnc, hostBase, tokenParam, entries, useProxy, streamType);
    }

    // Filter by streamType if requested
    let finalEntries = entries;
    if (streamType === 'live') {
        finalEntries = entries.filter((e) => e.type === 'live');
    } else if (streamType === 'movie' || streamType === 'vod' || streamType === 'movies') {
        finalEntries = entries.filter((e) => e.type === 'movie');
    } else if (streamType === 'series' || streamType === 'tvshows' || streamType === 'tv') {
        finalEntries = entries.filter((e) => e.type === 'series');
    }

    // Sort deterministically: Live -> Movies -> Series
    const sorted = sortExportEntries(finalEntries);
    for (const item of sorted) {
        if (res.writableEnded || res.destroyed) break;
        res.write(`${item.extinf}\n${item.streamUrl}\n`);
    }
}

async function collectMovies(
    cleanServer: string,
    userEnc: string,
    passEnc: string,
    hostBase: string,
    tokenParam: string,
    entries: M3uExportEntry[],
    useProxy = true
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

    for (const item of vodStreams) {
        if (!item || !item.stream_id) continue;
        const name = formatMovieTitle(item.name || `Movie ${item.stream_id}`);
        const ext = item.container_extension || 'mp4';
        const logo = item.stream_icon || '';
        const rawCat = (item.category_id && catMap.get(String(item.category_id))) || 'Other';
        const groupTitle = formatCategory(rawCat, 'movie');
        const rawStreamUrl = `${cleanServer}/movie/${userEnc}/${passEnc}/${item.stream_id}.${ext}`;
        const streamUrl = useProxy
            ? buildProxiedStreamUrl(hostBase, 'movie', rawStreamUrl, tokenParam, undefined, item.stream_id)
            : rawStreamUrl;

        const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(name)}" tvg-logo="${escapeAttr(logo)}" group-title="${escapeAttr(groupTitle)}",${name}`;
        entries.push({ type: 'movie', extinf, streamUrl, groupTitle, title: name });
    }
}

async function collectSeries(
    cleanServer: string,
    userEnc: string,
    passEnc: string,
    hostBase: string,
    tokenParam: string,
    entries: M3uExportEntry[],
    useProxy = true,
    streamType = ''
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

    const maxSeries = streamType === 'series' ? 300 : 50;
    const seriesToFetch = seriesList.slice(0, maxSeries);
    const CONCURRENCY = 8;
    let nextIdx = 0;

    const worker = async () => {
        while (nextIdx < seriesToFetch.length) {
            const series = seriesToFetch[nextIdx++];
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

            if (!info?.episodes) continue;

            const baseSeriesName = series.name || `Series ${series.series_id}`;
            const logo = series.cover || '';
            const rawCat = (series.category_id && catMap.get(String(series.category_id))) || baseSeriesName;
            const groupTitle = formatCategory(rawCat, 'series');

            for (const [seasonKey, episodes] of Object.entries(info.episodes)) {
                if (!Array.isArray(episodes)) continue;
                for (const ep of episodes) {
                    if (!ep?.id) continue;
                    const ext = ep.container_extension || 'mp4';
                    const season = Number(ep.season ?? seasonKey) || 1;
                    const episode = Number(ep.episode_num) || 1;
                    const sStr = String(season).padStart(2, '0');
                    const eStr = String(episode).padStart(2, '0');
                    const displayTitle = `${baseSeriesName} S${sStr}E${eStr}`;
                    const rawStreamUrl = `${cleanServer}/series/${userEnc}/${passEnc}/${ep.id}.${ext}`;
                    const streamUrl = useProxy
                        ? buildProxiedStreamUrl(hostBase, 'series', rawStreamUrl, tokenParam, series.series_id, ep.id)
                        : rawStreamUrl;

                    const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(displayTitle)}" tvg-logo="${escapeAttr(logo)}" group-title="${escapeAttr(groupTitle)}",${displayTitle}`;
                    entries.push({
                        type: 'series',
                        extinf,
                        streamUrl,
                        groupTitle,
                        title: baseSeriesName,
                        season,
                        episode,
                    });
                }
            }
        }
    };

    const pool = Array.from({ length: Math.min(CONCURRENCY, seriesToFetch.length) }, () => worker());
    await Promise.all(pool);
}

function collectM3uFromUrl(
    targetUrl: string,
    cleanServer: string,
    hostBase: string,
    tokenParam: string,
    entries: M3uExportEntry[],
    useProxy = true,
    streamType = '',
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
                rejectUnauthorized: false,
            },
            (upstream) => {
                const status = upstream.statusCode ?? 200;
                if (status >= 300 && status < 400 && upstream.headers.location) {
                    upstream.resume();
                    const redirectUrl = new URL(upstream.headers.location, targetUrl).href;
                    return resolve(
                        collectM3uFromUrl(redirectUrl, cleanServer, hostBase, tokenParam, entries, useProxy, streamType, hopCount + 1)
                    );
                }

                if (status !== 200) {
                    upstream.resume();
                    return resolve({ streamCount: 0, vodCount: 0, seriesCount: 0 });
                }

                let streamCount = 0;
                let vodCount = 0;
                let seriesCount = 0;
                let pendingExtinf = '';

                const rl = readline.createInterface({ input: upstream, crlfDelay: Infinity });
                rl.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#EXTM3U')) return;

                    if (trimmed.startsWith('#')) {
                        if (trimmed.startsWith('#EXTINF:')) pendingExtinf = trimmed;
                        return;
                    }

                    let fullUrl = trimmed;
                    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
                        try {
                            fullUrl = new URL(trimmed, targetUrl).href;
                        } catch {
                            fullUrl = `${cleanServer}/${trimmed.replace(/^\/+/, '')}`;
                        }
                    }

                    const groupMatch = pendingExtinf.match(/group-title="([^"]*)"/i);
                    const commaIdx = pendingExtinf.lastIndexOf(',');
                    const streamName = commaIdx >= 0 ? pendingExtinf.slice(commaIdx + 1).trim() : '';
                    const groupName = groupMatch ? groupMatch[1] : '';

                    const contentType = detectContentType(fullUrl, streamName, groupName);

                    if (contentType === 'series') seriesCount++;
                    else if (contentType === 'movie') vodCount++;
                    else streamCount++;

                    const logoMatch = pendingExtinf.match(/tvg-logo="([^"]*)"/i);
                    const tvgLogo = logoMatch ? logoMatch[1] : '';
                    const idMatch = pendingExtinf.match(/tvg-id="([^"]*)"/i);
                    const rawTvgId = idMatch ? idMatch[1] : '';

                    const groupTitle = formatCategory(groupName, contentType);

                    if (contentType === 'series') {
                        const parsedSeries = parseSeriesEpisode(streamName, groupName);
                        const streamUrl = useProxy
                            ? buildProxiedStreamUrl(hostBase, 'series', fullUrl, tokenParam, '1')
                            : fullUrl;
                        const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(parsedSeries.displayTitle)}" tvg-logo="${escapeAttr(tvgLogo)}" group-title="${escapeAttr(groupTitle)}",${parsedSeries.displayTitle}`;
                        entries.push({
                            type: 'series',
                            extinf,
                            streamUrl,
                            groupTitle,
                            title: parsedSeries.seriesTitle,
                            season: parsedSeries.season,
                            episode: parsedSeries.episode,
                        });
                    } else if (contentType === 'movie') {
                        const movieTitle = formatMovieTitle(streamName);
                        const streamUrl = useProxy
                            ? buildProxiedStreamUrl(hostBase, 'movie', fullUrl, tokenParam)
                            : fullUrl;
                        const extinf = `#EXTINF:-1 tvg-id="" tvg-name="${escapeAttr(movieTitle)}" tvg-logo="${escapeAttr(tvgLogo)}" group-title="${escapeAttr(groupTitle)}",${movieTitle}`;
                        entries.push({
                            type: 'movie',
                            extinf,
                            streamUrl,
                            groupTitle,
                            title: movieTitle,
                        });
                    } else {
                        const streamUrl = useProxy
                            ? buildProxiedStreamUrl(hostBase, 'live', fullUrl, tokenParam)
                            : fullUrl;
                        const tvgIdAttr = rawTvgId ? `tvg-id="${escapeAttr(rawTvgId)}" ` : '';
                        const extinf = `#EXTINF:-1 ${tvgIdAttr}tvg-name="${escapeAttr(streamName)}" tvg-logo="${escapeAttr(tvgLogo)}" group-title="${escapeAttr(groupTitle)}",${streamName}`;
                        entries.push({
                            type: 'live',
                            extinf,
                            streamUrl,
                            groupTitle,
                            title: streamName,
                        });
                    }
                    pendingExtinf = '';
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
