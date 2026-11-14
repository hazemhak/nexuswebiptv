import express from 'express';
import { createXtreamApiRouter } from './xtream-api-router';
import { createExportHandler } from './m3u-export-router';
import { withServer } from './web-backend-app.spec-helpers';
import { withTempStorage, m3uDocument } from './storage/server-storage.spec-helpers';
import { sharedXtreamCache } from './xtream-cache-service';
import { sharedStreamCatalog } from './stream-catalog-service';

describe('xtream api router', () => {
    beforeEach(() => {
        sharedXtreamCache.clear();
        sharedStreamCatalog.clear();
    });

    it('returns user_info and server_info on base player_api.php call', async () => {
        await withTempStorage(async (storage) => {
            const app = express();
            app.use(createXtreamApiRouter(storage, null));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/player_api.php?username=test&password=test`);
                expect(res.status).toBe(200);
                const data = (await res.json()) as {
                    user_info: { auth: number; status: string };
                    server_info: { server_protocol: string };
                };
                expect(data.user_info.auth).toBe(1);
                expect(data.user_info.status).toBe('Active');
                expect(data.server_info.server_protocol).toBe('http');
            });
        });
    });

    it('enforces authentication when accessToken is configured', async () => {
        await withTempStorage(async (storage) => {
            const app = express();
            app.use(createXtreamApiRouter(storage, 'secret-pass'));
            await withServer(app, async (baseUrl) => {
                // Wrong password
                const resBad = await fetch(`${baseUrl}/player_api.php?username=admin&password=wrong`);
                const dataBad = (await resBad.json()) as { user_info: { auth: number; status: string } };
                expect(dataBad.user_info.auth).toBe(0);
                expect(dataBad.user_info.status).toBe('Disabled');

                // Correct password as password param
                const resGood = await fetch(`${baseUrl}/player_api.php?username=admin&password=secret-pass`);
                const dataGood = (await resGood.json()) as { user_info: { auth: number } };
                expect(dataGood.user_info.auth).toBe(1);

                // Correct password as username param
                const resUser = await fetch(`${baseUrl}/player_api.php?username=secret-pass&password=any`);
                const dataUser = (await resUser.json()) as { user_info: { auth: number } };
                expect(dataUser.user_info.auth).toBe(1);
            });
        });
    });

    it('returns categories, streams, filtered lists, and vod info from local playlists', async () => {
        await withTempStorage(async (storage) => {
            const doc = {
                ...m3uDocument('test-pl', 'Test Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        { name: 'BBC News', url: 'http://stream.example/live/bbc.ts', group: { title: 'News' } },
                        { name: 'CNN', url: 'http://stream.example/live/cnn.ts', group: { title: 'News' } },
                        { name: 'Inception (2010)', url: 'http://stream.example/movie/101.mp4', group: { title: 'Sci-Fi' } },
                        { name: 'Dark S01E01', url: 'http://stream.example/series/201.mp4', group: { title: 'Mystery' } },
                    ],
                },
            };
            storage.playlists.upsert(doc, { keepPayload: false });

            const app = express();
            app.use(createXtreamApiRouter(storage, null));
            await withServer(app, async (baseUrl) => {
                // Live categories
                const resLiveCat = await fetch(`${baseUrl}/player_api.php?action=get_live_categories`);
                const liveCats = (await resLiveCat.json()) as Array<{ category_name: string; category_id: string }>;
                expect(Array.isArray(liveCats)).toBe(true);
                const newsCat = liveCats.find((c) => c.category_name.includes('News'));
                expect(newsCat).toBeDefined();

                // Live streams
                const resLiveStreams = await fetch(`${baseUrl}/player_api.php?action=get_live_streams`);
                const liveStreams = (await resLiveStreams.json()) as Array<{ name: string; category_id: string }>;
                expect(Array.isArray(liveStreams)).toBe(true);
                expect(liveStreams.length).toBe(2);

                // Filter live streams by category_id
                const resFilteredLive = await fetch(
                    `${baseUrl}/player_api.php?action=get_live_streams&category_id=${newsCat?.category_id}`
                );
                const filteredLive = (await resFilteredLive.json()) as Array<{ name: string }>;
                expect(filteredLive.length).toBe(2);

                // VOD streams
                const resVodStreams = await fetch(`${baseUrl}/player_api.php?action=get_vod_streams`);
                const vodStreams = (await resVodStreams.json()) as Array<{ name: string; stream_id: number }>;
                expect(Array.isArray(vodStreams)).toBe(true);
                const inception = vodStreams.find((s) => s.name.includes('Inception'));
                expect(inception).toBeDefined();

                // VOD info details (action=get_vod_info)
                const resVodInfo = await fetch(
                    `${baseUrl}/player_api.php?action=get_vod_info&vod_id=${inception?.stream_id}`
                );
                const vodInfo = (await resVodInfo.json()) as {
                    info: { name: string; plot: string; genre: string };
                    movie_data: { stream_id: number; name: string };
                };
                expect(vodInfo.info).toBeDefined();
                expect(vodInfo.info.name).toContain('Inception');
                expect(vodInfo.info.plot).toBeDefined();
                expect(vodInfo.movie_data.stream_id).toBe(inception?.stream_id);

                // Series
                const resSeries = await fetch(`${baseUrl}/player_api.php?action=get_series`);
                const seriesList = (await resSeries.json()) as Array<{ name: string; series_id: string }>;
                expect(Array.isArray(seriesList)).toBe(true);
                const darkSeries = seriesList.find((s) => s.name === 'Dark');
                expect(darkSeries).toBeDefined();

                // Series info
                const resInfo = await fetch(
                    `${baseUrl}/player_api.php?action=get_series_info&series_id=${darkSeries?.series_id}`
                );
                const seriesInfo = (await resInfo.json()) as {
                    episodes: Record<string, Array<{ title: string }>>;
                };
                expect(seriesInfo.episodes['1']).toBeDefined();
                expect(seriesInfo.episodes['1'][0].title).toBe('Dark S01E01');
            });
        });
    });

    it('serves get.php via exportHandler', async () => {
        await withTempStorage(async (storage) => {
            const doc = {
                ...m3uDocument('test-pl', 'Test Playlist'),
                playlist: {
                    header: { raw: '#EXTM3U' },
                    items: [
                        { name: 'Channel X', url: 'http://stream.example/live/x.ts' },
                    ],
                },
            };
            storage.playlists.upsert(doc, { keepPayload: false });

            const app = express();
            const exportHandler = createExportHandler(storage, null);
            app.use(createXtreamApiRouter(storage, null, null, exportHandler));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/get.php?username=admin&password=any&type=m3u_plus`);
                expect(res.status).toBe(200);
                const text = await res.text();
                expect(text).toContain('#EXTM3U');
                expect(text).toContain('Channel X');
            });
        });
    });

    it('returns empty placeholder when database has 0 playlists', async () => {
        await withTempStorage(async (storage) => {
            const app = express();
            app.use(createXtreamApiRouter(storage, null));
            await withServer(app, async (baseUrl) => {
                const res = await fetch(`${baseUrl}/player_api.php?action=get_live_streams`);
                const data = (await res.json()) as Array<{ name: string }>;
                expect(Array.isArray(data)).toBe(true);
                expect(data[0].name).toContain('No Playlists');
            });
        });
    });
});
