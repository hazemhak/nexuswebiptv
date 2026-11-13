import express from 'express';
import { createM3uExportRouter } from './m3u-export-router';
import { withServer } from './web-backend-app.spec-helpers';
import { withTempStorage, m3uDocument } from './storage/server-storage.spec-helpers';
import {
    detectContentType,
    formatMovieCategory,
    formatSeriesCategory,
} from './m3u-export-classifier';

describe('m3u export router', () => {
    it('formats movie and series categories cleanly', () => {
        expect(formatMovieCategory('Action')).toBe('Movies - Action');
        expect(formatMovieCategory('Movies - Action')).toBe('Movies - Action');
        expect(formatMovieCategory('Movies')).toBe('Movies');
        expect(formatSeriesCategory('Drama')).toBe('Series - Drama');
        expect(formatSeriesCategory('TV Shows')).toBe('TV Shows');
    });

    it('accurately detects series, movies, and live streams', () => {
        // Series detection takes precedence even if the URL ends in .mp4
        expect(detectContentType('http://example.com/series/user/pass/123.mp4', 'Show', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Lost S01E01', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show 1x05', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show Season 2', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show Episode 4', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'مسلسل الحفرة', 'Drama')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show', 'English Series')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show', 'TV Shows')).toBe('series');
        expect(detectContentType('http://example.com/stream.mp4', 'Show', 'مسلسلات')).toBe('series');

        // Movies (only when not a series)
        expect(detectContentType('http://example.com/movie/user/pass/456.mp4', 'Avatar', 'Action')).toBe('movie');
        expect(detectContentType('http://example.com/vod/item.mkv', 'The Matrix', 'Sci-Fi')).toBe('movie');
        expect(detectContentType('http://example.com/film.mp4', 'Gladiator', 'Action')).toBe('movie');
        expect(detectContentType('http://example.com/film.avi', 'Alien', 'Movies')).toBe('movie');

        // Live streams
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

    it('exports playlist as Extended M3U with proper headers and proxy URLs', async () => {
        await withTempStorage(async (storage) => {
            const doc = {
                ...m3uDocument('p1', 'My Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        {
                            name: 'BBC One',
                            url: 'http://stream.example/live/1.ts',
                            tvg: { id: 'bbc1', name: 'BBC One', logo: 'http://logo.png' },
                            group: { title: 'UK' },
                        },
                        {
                            name: 'Inception',
                            url: 'http://stream.example/movie/inception.mp4',
                            tvg: { id: '', name: 'Inception', logo: '' },
                            group: { title: 'Action' },
                        },
                        {
                            name: 'Breaking Bad S01E01',
                            url: 'http://stream.example/series/bb/ep1.mp4',
                            tvg: { id: '', name: 'Breaking Bad S01E01', logo: '' },
                            group: { title: 'Crime Drama' },
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

                // Very first line must be #EXTM3U exactly once
                expect(lines[0]).toBe('#EXTM3U');
                expect(lines.slice(1).some((l) => l.startsWith('#EXTM3U'))).toBe(false);

                // Check live channel format
                expect(text).toContain('#EXTINF:-1 tvg-id="bbc1" tvg-name="BBC One" tvg-logo="http://logo.png" group-title="UK",BBC One');
                expect(text).toContain('/stream-proxy/live/1.ts?url=http%3A%2F%2Fstream.example%2Flive%2F1.ts&token=secret-token');

                // Check movie format (dedicated movie subpath and formatted group)
                expect(text).toContain('#EXTINF:-1 tvg-name="Inception" group-title="Movies - Action",Inception');
                expect(text).toContain('/stream-proxy/movie/inception.mp4?url=http%3A%2F%2Fstream.example%2Fmovie%2Finception.mp4&token=secret-token');

                // Check series format (dedicated series subpath and formatted group)
                expect(text).toContain('#EXTINF:-1 tvg-name="Breaking Bad S01E01" group-title="Series - Crime Drama",Breaking Bad S01E01');
                expect(text).toContain('/stream-proxy/series/ep1.mp4?url=http%3A%2F%2Fstream.example%2Fseries%2Fbb%2Fep1.mp4&token=secret-token');
            });
        });
    });

    it('exports filtered playlist by stream_type', async () => {
        await withTempStorage(async (storage) => {
            const doc = {
                ...m3uDocument('p2', 'Mixed Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        { name: 'Live 1', url: 'http://stream.example/live/1.ts' },
                        { name: 'Movie 1', url: 'http://stream.example/movie/1.mp4' },
                        { name: 'Series S01E01', url: 'http://stream.example/series/1.mp4' },
                    ],
                },
            };
            storage.playlists.upsert(doc, { keepPayload: false });

            const app = express();
            app.use(createM3uExportRouter(storage, null));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/m3u?type=series`);
                expect(res.status).toBe(200);
                const text = await res.text();
                expect(text).toContain('Series S01E01');
                expect(text).not.toContain('Live 1');
                expect(text).not.toContain('Movie 1');
            });
        });
    });

    it('exports single playlist by ID and supports proxy=0', async () => {
        await withTempStorage(async (storage) => {
            const doc = {
                ...m3uDocument('pl-42', 'Direct Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        {
                            name: 'Direct Channel',
                            url: 'http://direct.example/live.m3u8',
                        },
                    ],
                },
            };
            storage.playlists.upsert(doc, { keepPayload: false });

            const app = express();
            app.use(createM3uExportRouter(storage, null));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/m3u/pl-42.m3u?proxy=0`);
                expect(res.status).toBe(200);
                const text = await res.text();
                expect(text).toContain('http://direct.example/live.m3u8');
                expect(text).not.toContain('/stream-proxy');
            });
        });
    });
});
