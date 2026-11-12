import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import express, { type Express, type Response } from 'express';

function isStreamProxyEnabled(): boolean {
    const value = process.env['IPTVNATOR_STREAM_PROXY'];
    if (value === undefined) return true; // Default on in Docker
    return value === '1' || value === 'true';
}

export function createHostedWebApp(api: Express, assets: string): Express {
    const index = readFileSync(join(assets, 'index.html'), 'utf8');
    const sendIndex = (res: Response) =>
        res.set('Cache-Control', 'no-cache').type('html').send(index);
    const app = express();
    app.disable('x-powered-by');
    app.use('/api', api);
    app.use('/api', (_req, res) => res.sendStatus(404));
    app.get('/assets/app-config.js', (_req, res) => {
        const streamProxyEnabled = isStreamProxyEnabled();
        res.set('Cache-Control', 'no-store')
            .type('js')
            .send(
                `window.__IPTVNATOR_CONFIG__ = { BACKEND_URL: "/api", STREAM_PROXY_ENABLED: ${streamProxyEnabled} };`
            );
    });
    app.get(['/', '/index.html'], (_req, res) => sendIndex(res));
    app.use(express.static(assets, { index: false, redirect: false }));
    app.get('/{*path}', (req, res, next) => {
        if (extname(req.path) || !req.accepts('html')) return next();
        return sendIndex(res);
    });
    return app;
}
