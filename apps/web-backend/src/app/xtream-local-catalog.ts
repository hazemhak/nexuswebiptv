/**
 * Xtream Local Catalog
 *
 * Converts stored local M3U playlists into Xtream Codes API data structures
 * (categories, streams, series, VOD info) with in-memory caching.
 */

import type { Request } from 'express';
import {
    detectContentType,
    formatCategory,
    parseSeriesEpisode,
    formatMovieTitle,
} from './m3u-export-classifier';
import { sharedStreamCatalog } from './stream-catalog-service';

export interface LocalXtreamData {
    readonly liveCategories: Array<{ category_id: string; category_name: string; parent_id: number }>;
    readonly liveStreams: Array<Record<string, unknown>>;
    readonly vodCategories: Array<{ category_id: string; category_name: string; parent_id: number }>;
    readonly vodStreams: Array<Record<string, unknown>>;
    readonly seriesCategories: Array<{ category_id: string; category_name: string; parent_id: number }>;
    readonly seriesList: Array<Record<string, unknown>>;
    readonly seriesEpisodes: Map<string, Array<Record<string, unknown>>>;
    readonly vodMap: Map<string, Record<string, unknown>>;
}

export function buildLocalXtreamCatalog(playlists: Array<Record<string, unknown>>): LocalXtreamData {
    const liveCatMap = new Map<string, string>();
    const vodCatMap = new Map<string, string>();
    const seriesCatMap = new Map<string, string>();

    const liveStreams: Array<Record<string, unknown>> = [];
    const vodStreams: Array<Record<string, unknown>> = [];
    const seriesList: Array<Record<string, unknown>> = [];
    const seriesEpisodes = new Map<string, Array<Record<string, unknown>>>();
    const vodMap = new Map<string, Record<string, unknown>>();

    let catIdCounter = 1;
    const getCatId = (name: string, map: Map<string, string>): string => {
        let id = map.get(name);
        if (!id) {
            id = String(catIdCounter++);
            map.set(name, id);
        }
        return id;
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
            const streamId = ++streamIdCounter;

            sharedStreamCatalog.register({ id: streamId, type: contentType, url: rawUrl, name });

            if (contentType === 'live') {
                const catId = getCatId(groupTitle, liveCatMap);
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
                const catId = getCatId(groupTitle, vodCatMap);
                const title = formatMovieTitle(name);
                const vodEntry = {
                    num: vodStreams.length + 1,
                    name: title,
                    stream_type: 'movie',
                    stream_id: streamId,
                    stream_icon: tvg['logo'] || '',
                    rating: '8.0',
                    rating_5based: 4.0,
                    added: '1600000000',
                    category_id: catId,
                    category_name: groupTitle,
                    container_extension: 'mp4',
                    custom_sid: '',
                    direct_source: '',
                };
                vodStreams.push(vodEntry);
                vodMap.set(String(streamId), vodEntry);
            } else if (contentType === 'series') {
                const catId = getCatId(groupTitle, seriesCatMap);
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
                    seriesEpisodes.set(sid, []);
                }
                const sid = String(series['series_id']);
                seriesEpisodes.get(sid)?.push({
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

    const liveCategories = Array.from(liveCatMap.entries()).map(([name, id]) => ({
        category_id: id,
        category_name: name,
        parent_id: 0,
    }));
    const vodCategories = Array.from(vodCatMap.entries()).map(([name, id]) => ({
        category_id: id,
        category_name: name,
        parent_id: 0,
    }));
    const seriesCategories = Array.from(seriesCatMap.entries()).map(([name, id]) => ({
        category_id: id,
        category_name: name,
        parent_id: 0,
    }));

    return {
        liveCategories,
        liveStreams,
        vodCategories,
        vodStreams,
        seriesCategories,
        seriesList,
        seriesEpisodes,
        vodMap,
    };
}

export function buildVodInfoResponse(movie: Record<string, unknown> | undefined, vodId: string) {
    const name = movie ? String(movie['name'] || `Movie ${vodId}`) : `Movie ${vodId}`;
    const icon = movie ? String(movie['stream_icon'] || '') : '';
    const catId = movie ? String(movie['category_id'] || '1') : '1';
    const genre = movie ? String(movie['category_name'] || 'Movies') : 'Movies';

    return {
        info: {
            name,
            o_name: name,
            cover_big: icon,
            movie_image: icon,
            releasedate: '',
            episode_run_time: '120',
            youtube_trailer: '',
            director: 'Unknown',
            actors: 'Cast',
            cast: 'Cast',
            description: name,
            plot: name,
            age: '',
            mpaa_rating: '',
            rating_count_kinopoisk: 0,
            country: '',
            genre,
            backdrop_path: icon ? [icon] : [],
            duration_secs: 7200,
            duration: '02:00:00',
            video: {},
            audio: {},
            bitrate: 0,
            rating: '8.0',
        },
        movie_data: {
            stream_id: Number(vodId) || 1000,
            name,
            title: name,
            year: '',
            added: '1600000000',
            category_id: catId,
            container_extension: 'mp4',
            custom_sid: '',
            direct_source: '',
        },
    };
}

export function buildSeriesInfoResponse(catalog: LocalXtreamData, seriesId: string) {
    const series = catalog.seriesList.find((s) => String(s['series_id']) === seriesId);
    const epList = catalog.seriesEpisodes.get(seriesId) || [];
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

export function buildUserInfo(username: string, password: string) {
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

export function buildServerInfo(req: Request) {
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
