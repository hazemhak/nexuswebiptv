import { HISTORY_SYNC_CAPABILITY } from '@iptvnator/shared/interfaces/history-sync';
import express, { Router } from 'express';
import {
    SERVER_STORAGE_API_VERSION,
    SOURCE_SYNC_CAPABILITY,
    type ServerInstanceInfo,
    type ServerStorageStatusResponse,
} from '@iptvnator/shared/interfaces';
import type { ServerStorage } from './server-storage';
import { StorageRequestError } from './storage-route-errors';
import { FAVORITES_SYNC_CAPABILITY } from '@iptvnator/shared/interfaces/favorites-sync';
import { ACTIVITY_SYNC_CAPABILITY } from '@iptvnator/shared/interfaces/activity-sync';

export function createInstanceRouter(deps: {
    readonly storage: ServerStorage | null;
    readonly accessTokenRequired: boolean;
    readonly uiPassword?: string | null;
    readonly accessToken?: string | null;
}): Router {
    const router = Router();

    router.get('/instance', (_req, res) => {
        const body: ServerInstanceInfo = {
            ...(deps.storage
                ? {
                      capabilities: [
                          SOURCE_SYNC_CAPABILITY,
                          ACTIVITY_SYNC_CAPABILITY,
                          FAVORITES_SYNC_CAPABILITY,
                          HISTORY_SYNC_CAPABILITY,
                      ],
                  }
                : {}),
            service: 'iptvnator',
            apiVersion: SERVER_STORAGE_API_VERSION,
            instanceId: deps.storage?.database.instanceId ?? null,
            storage: deps.storage ? 'server' : 'none',
            auth:
                deps.accessTokenRequired || !!deps.uiPassword ? 'token' : 'none',
            ...(deps.uiPassword ? { uiPassword: true } : {}),
        };
        res.set('Cache-Control', 'no-store').json(body);
    });

    router.post('/auth/login', express.json(), (req, res) => {
        const password =
            typeof req.body?.password === 'string'
                ? req.body.password.trim()
                : '';
        const token =
            typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        const entered = password || token;

        if (deps.uiPassword) {
            if (entered && entered === deps.uiPassword) {
                res.json({
                    ok: true,
                    token: deps.accessToken || deps.uiPassword,
                });
                return;
            }
            res.status(401).json({
                message: 'Invalid password',
                status: 401,
                code: 'unauthorized',
            });
            return;
        }

        if (deps.accessToken) {
            if (entered && entered === deps.accessToken) {
                res.json({ ok: true, token: deps.accessToken });
                return;
            }
            res.status(401).json({
                message: 'Invalid token',
                status: 401,
                code: 'unauthorized',
            });
            return;
        }

        res.json({ ok: true, token: '' });
    });

    router.get('/instance/status', (_req, res) => {
        const storage = deps.storage;
        if (!storage) {
            throw new StorageRequestError(
                404,
                'storage_disabled',
                'Server storage is not enabled.'
            );
        }
        const body: ServerStorageStatusResponse = {
            playlists: storage.playlists.count(),
            databaseBytes: storage.database.sizeBytes(),
            databasePath: storage.database.path,
            startedAt: storage.startedAt.toISOString(),
        };
        res.set('Cache-Control', 'no-store').json(body);
    });

    return router;
}
