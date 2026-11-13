import express from 'express';
import { createM3uExportRouter } from './m3u-export-router';
import { withServer } from './web-backend-app.spec-helpers';
import { withTempStorage, m3uDocument } from './storage/server-storage.spec-helpers';
import {
    detectContentType,
    formatCategory,
    parseSeriesEpisode,
    formatMovieTitle,
} from './m3u-export-classifier';
import { validateM3uExportContent } from './m3u-export-validator';

describe('m3u export router and classifier', () => {
    it('formats categories with required Live, Movies, Series prefixes', () => {
        expect(formatCategory('News', 'live')).toBe('Live | News');
        expect(formatCategory('Live | News', 'live')).toBe('Live | News');
        expect(formatCategory('', 'live')).toBe('Live | Other');

        expect(formatCategory('Action', 'movie')).toBe('Movies | Action');
        expect(formatCategory('Movies - Action', 'movie')).toBe('Movies | Action');
        expect(formatCategory('', 'movie')).toBe('Movies | Other');

        expect(formatCategory('Drama', 'series')).toBe('Series | Drama');
        expect(formatCategory('TV Shows | Drama', 'series')).toBe('Series | Drama');
        expect(formatCategory('', 'series')).toBe('Series | Other');
    });

    it('accurately parses series episode and formats SxxExx display titles', () => {
        const ep1 = parseSeriesEpisode('Breaking Bad S01E01');
        expect(ep1.seriesTitle).toBe('Breaking Bad');
        expect(ep1.season).toBe(1);
        expect(ep1.episode).toBe(1);
        expect(ep1.displayTitle).toBe('Breaking Bad S01E01');

        const ep2 = parseSeriesEpisode('Game of Thrones 2x05 [1080p]');
        expect(ep2.seriesTitle).toBe('Game of Thrones');
        expect(ep2.season).toBe(2);
        expect(ep2.episode).toBe(5);
        expect(ep2.displayTitle).toBe('Game of Thrones S02E05');

        const ep3 = parseSeriesEpisode('مسلسل الاختيار الحلقة 4');
        expect(ep3.seriesTitle).toBe('مسلسل الاختيار');
        expect(ep3.season).toBe(1);
        expect(ep3.episode).toBe(4);
        expect(ep3.displayTitle).toBe('مسلسل الاختيار S01E04');
    });

    it('normalizes movie titles with year', () => {
        expect(formatMovieTitle('Inception (2010)')).toBe('Inception (2010)');
        expect(formatMovieTitle('The Matrix 1999 [1080p]')).toBe('The Matrix (1999)');
        expect(formatMovieTitle('Avatar [4K]')).toBe('Avatar');
    });

    it('accurately detects series, movies, and live streams', () => {
        expect(detectContentType('http://example.com/series/user/pass/123.mp4', 'Show', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Lost S01E01', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show 1x05', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show Season 2', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show Episode 4', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'مسلسل الحفرة', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show', 'English Series')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show', 'مسلسلات')).toBe('series');

        expect(detectContentType('http://example.com/movie/user/pass/456.mp4', 'Avatar', 'Action')).toBe('movie');
        expect(detectContentType('http://example.com/vod/item.mkv', 'The Matrix', 'Sci-Fi')).toBe('movie');
        expect(detectContentType('http://example.com/film.mp4', 'Gladiator (2000)', 'Action')).toBe('movie');

        expect(detectContentType('http://example.com/live/user/pass/789.ts', 'Sky News', 'News')).toBe('live');
        expect(detectContentType('http://example.com/stream.m3u8', 'BBC World', 'News')).toBe('live');
    });

    it('returns 401 when token is missing or wrong', async () => {
        await withTempStorage(async (storage) => {
            const app = express();
            app.use(createM3uExportRouter(storage, 'secret-token'));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/m3u`);
                expect(res.status).toBe(401);
                const text = await res.text();
                expect(text).toContain('Unauthorized');
            });
        });
    });

    it('exports playlist with strict ordering: Live TV first, Movies second, Series third', async () => {
        await withTempStorage(async (storage) => {
            // Intentionally provide items in interleaved/reversed order
            const doc = {
                ...m3uDocument('p1', 'My Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        {
                            name: 'Breaking Bad S01E01',
                            url: 'http://stream.example/series/bb/ep1.mp4',
                            tvg: { id: 'series-tvg', name: 'Breaking Bad S01E01', logo: 'http://poster.jpg' },
                            group: { title: 'Crime' },
                        },
                        {
                            name: 'Inception (2010)',
                            url: 'http://stream.example/movie/inception.mp4',
                            tvg: { id: 'movie-tvg', name: 'Inception', logo: 'http://poster2.jpg' },
                            group: { title: 'Sci-Fi' },
                        },
                        {
                            name: 'BBC One',
                            url: 'http://stream.example/live/1.ts',
                            tvg: { id: 'bbc1', name: 'BBC One', logo: 'http://logo.png' },
                            group: { title: 'News' },
                        },
                    ],
                },
            };
            storage.playlists.upsert(doc, { keepPayload: false });

            const app = express();
            app.use(createM3uExportRouter(storage, 'secret-token'));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/m3u.m3u?token=secret-token`);
                expect(res.status).toBe(200);
                expect(res.headers.get('content-type')).toBe('application/x-mpegurl; charset=utf-8');

                const text = await res.text();
                const lines = text.split('\n').filter((l) => l.trim().length > 0);

                // Very first line must be #EXTM3U
                expect(lines[0]).toBe('#EXTM3U');

                // Validate using the Section 8 criteria
                const validation = validateM3uExportContent(text);
                expect(validation.errors).toEqual([]);
                expect(validation.valid).toBe(true);
                expect(validation.liveCount).toBe(1);
                expect(validation.movieCount).toBe(1);
                expect(validation.seriesCount).toBe(1);

                // Live must be first, Movie second, Series third
                const liveIdx = text.indexOf('BBC One');
                const movieIdx = text.indexOf('Inception (2010)');
                const seriesIdx = text.indexOf('Breaking Bad S01E01');
                expect(liveIdx).toBeLessThan(movieIdx);
                expect(movieIdx).toBeLessThan(seriesIdx);

                // Movies and series must leave tvg-id=""
                expect(text).toContain('#EXTINF:-1 tvg-id="" tvg-name="Inception (2010)"');
                expect(text).toContain('#EXTINF:-1 tvg-id="" tvg-name="Breaking Bad S01E01"');

                // Live preserves tvg-id
                expect(text).toContain('tvg-id="bbc1"');

                // Stream URL path patterns
                expect(text).toContain('/live/1.ts?url=');
                expect(text).toContain('/movie/inception.mp4?url=');
                expect(text).toContain('/series/1/ep1.mp4?url=');
            });
        });
    });

    it('exports split files: /live.m3u, /movies.m3u, and /series.m3u', async () => {
        await withTempStorage(async (storage) => {
            const doc = {
                ...m3uDocument('p2', 'Split Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        { name: 'Live Channel', url: 'http://stream.example/live/live1.ts' },
                        { name: 'Film (2022)', url: 'http://stream.example/movie/film1.mp4' },
                        { name: 'Show S01E01', url: 'http://stream.example/series/show1.mp4' },
                    ],
                },
            };
            storage.playlists.upsert(doc, { keepPayload: false });

            const app = express();
            app.use(createM3uExportRouter(storage, null));
            await withServer(app, async (baseUrl) => {
                // Live only
                const liveRes = await fetch(`${baseUrl}/live.m3u`);
                expect(liveRes.status).toBe(200);
                const liveText = await liveRes.text();
                expect(liveText).toContain('Live Channel');
                expect(liveText).not.toContain('Film (2022)');
                expect(liveText).not.toContain('Show S01E01');

                // Movies only
                const movieRes = await fetch(`${baseUrl}/movies.m3u`);
                expect(movieRes.status).toBe(200);
                const movieText = await movieRes.text();
                expect(movieText).toContain('Film (2022)');
                expect(movieText).not.toContain('Live Channel');
                expect(movieText).not.toContain('Show S01E01');

                // Series only
                const seriesRes = await fetch(`${baseUrl}/series.m3u`);
                expect(seriesRes.status).toBe(200);
                const seriesText = await seriesRes.text();
                expect(seriesText).toContain('Show S01E01');
                expect(seriesText).not.toContain('Live Channel');
                expect(seriesText).not.toContain('Film (2022)');
            });
        });
    });

    it('supports path-based token and playlist.m3u for IPTV Smarters', async () => {
        await withTempStorage(async (storage) => {
            const doc = {
                ...m3uDocument('p3', 'Token Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        { name: 'Channel A', url: 'http://stream.example/live/a.ts' },
                        { name: 'Series B S01E01', url: 'http://stream.example/series/b.mp4' },
                    ],
                },
            };
            storage.playlists.upsert(doc, { keepPayload: false });

            const app = express();
            app.use(createM3uExportRouter(storage, 'my-secret'));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/m3u/token/my-secret/playlist.m3u`);
                expect(res.status).toBe(200);
                const text = await res.text();
                expect(text).toContain('Channel A');
                expect(text).toContain('Series B S01E01');

                const resDirect = await fetch(`${baseUrl}/m3u/token/my-secret/direct/playlist.m3u`);
                expect(resDirect.status).toBe(200);
                const textDirect = await resDirect.text();
                expect(textDirect).toContain('http://stream.example/live/a.ts');
                expect(textDirect).not.toContain('/live/a.ts?url=');
            });
        });
    });
});
