export interface ServerStorageConfig {
    /** `IPTVNATOR_STORAGE=server`; the Docker image sets it. */
    readonly enabled: boolean;
    /** `IPTVNATOR_ACCESS_TOKEN`; guards every non-public route when set. */
    readonly accessToken: string | null;
    /** `IPTVNATOR_UI_PASSWORD`; guards the web interface when set. */
    readonly uiPassword: string | null;
    /** Largest accepted playlist document (`IPTVNATOR_MAX_DOCUMENT_MB`). */
    readonly maxDocumentBytes: number;
}

const DEFAULT_MAX_DOCUMENT_MB = 64;
const BYTES_PER_MB = 1024 * 1024;

/**
 * A combination the browser app cannot use, as a start-up message, or
 * `null`. The PWA asks for the access token only in server storage mode,
 * so a token on a stateless backend would lock every browser out.
 */
export function serverStorageConfigProblem(
    config: ServerStorageConfig
): string | null {
    if ((config.accessToken || config.uiPassword) && !config.enabled) {
        return 'IPTVNATOR_ACCESS_TOKEN and IPTVNATOR_UI_PASSWORD need IPTVNATOR_STORAGE=server: the browser app asks for authentication only when the server stores its playlists. Unset the credentials, or protect a stateless backend in your reverse proxy.';
    }
    return null;
}

export function readServerStorageConfig(
    env: Record<string, string | undefined> = process.env
): ServerStorageConfig {
    const mode = env['IPTVNATOR_STORAGE']?.trim().toLowerCase();
    const token = env['IPTVNATOR_ACCESS_TOKEN']?.trim();
    const uiPassword =
        env['IPTVNATOR_UI_PASSWORD']?.trim() ||
        env['IPTVNATOR_WEB_PASSWORD']?.trim() ||
        env['UI_PASSWORD']?.trim();
    const megabytes = Number(env['IPTVNATOR_MAX_DOCUMENT_MB']);

    return {
        enabled: mode === 'server',
        accessToken: token ? token : null,
        uiPassword: uiPassword ? uiPassword : null,
        maxDocumentBytes:
            (Number.isFinite(megabytes) && megabytes > 0
                ? megabytes
                : DEFAULT_MAX_DOCUMENT_MB) * BYTES_PER_MB,
    };
}
