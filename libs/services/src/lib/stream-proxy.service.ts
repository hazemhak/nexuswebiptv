/**
 * StreamProxyService
 *
 * Rewrites IPTV stream URLs so that all media traffic flows through the
 * self-hosted server rather than the user's browser making direct requests
 * to the stream origin.
 *
 * Usage: inject this service wherever a playback URL is handed to a player
 * component, then call `rewrite(url)` before passing the URL to the player.
 *
 * The service is a no-op in Electron (desktop) mode: in that environment MPV
 * or VLC handle the stream natively, so no browser-level CORS issues apply.
 * It is also a no-op when no backend URL is configured (offline / file mode).
 *
 * Rewriting is opt-in via the environment variable
 *   IPTVNATOR_STREAM_PROXY=1   (set in docker-compose.yml)
 * and the runtime config flag
 *   window.__IPTVNATOR_CONFIG__.STREAM_PROXY_ENABLED = true
 *
 * Without that flag the service returns the original URL unchanged so the
 * existing direct-browser behaviour is preserved for people who do not need
 * the proxy.
 */
import { Injectable } from '@angular/core';
import { readServerAccessToken } from './server-access-token';

@Injectable({ providedIn: 'root' })
export class StreamProxyService {
    /**
     * Returns the proxy URL for the given stream URL, or the original URL if
     * the proxy is disabled or the input is not a proxiable http/https URL.
     */
    rewrite(streamUrl: string, userAgent?: string): string {
        if (!this.isEnabled()) return streamUrl;
        if (!streamUrl) return streamUrl;

        // Only proxy HTTP/HTTPS streams; leave rtmp://, data:, etc. alone.
        if (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://')) {
            return streamUrl;
        }

        // Already pointing at our own proxy — don't double-wrap.
        if (this.isAlreadyProxied(streamUrl)) return streamUrl;

        const backendUrl = this.backendUrl();
        let proxyUrl = `${backendUrl}/stream-proxy?url=${encodeURIComponent(streamUrl)}`;
        if (userAgent) {
            proxyUrl += `&userAgent=${encodeURIComponent(userAgent)}`;
        }
        const token = this.accessToken();
        if (token) {
            proxyUrl += `&token=${encodeURIComponent(token)}`;
        }
        return proxyUrl;
    }

    /**
     * Returns an absolute proxy URL suitable for external players (VLC, MPV)
     * and copying to clipboard.
     */
    rewriteForExternal(streamUrl: string, userAgent?: string): string {
        if (!streamUrl) return streamUrl;
        const proxied = this.rewrite(streamUrl, userAgent);
        if (typeof window !== 'undefined' && proxied.startsWith('/')) {
            return `${window.location.origin}${proxied}`;
        }
        return proxied;
    }

    /**
     * Whether stream proxying is currently active.
     * Callers can use this to adjust UI (e.g. show a "via server" badge).
     */
    isEnabled(): boolean {
        if (typeof window !== 'undefined') {
            try {
                const saved = localStorage.getItem('iptvnator_stream_proxy_enabled');
                if (saved !== null) {
                    return saved === 'true';
                }
            } catch {
                // Ignore localStorage errors
            }
        }
        return !!window.__IPTVNATOR_CONFIG__?.STREAM_PROXY_ENABLED;
    }

    private backendUrl(): string {
        return window.__IPTVNATOR_CONFIG__?.BACKEND_URL ?? '/api';
    }

    private accessToken(): string | null {
        return (
            (window as unknown as { __IPTVNATOR_CONFIG__?: { ACCESS_TOKEN?: string } })
                ?.__IPTVNATOR_CONFIG__?.ACCESS_TOKEN?.trim() ||
            readServerAccessToken() ||
            null
        );
    }

    private isAlreadyProxied(url: string): boolean {
        const backend = this.backendUrl();
        // Strip leading slash so it works for both '/api' and 'http://host/api'
        const proxyPath = `${backend}/stream-proxy`;
        return url.includes(proxyPath);
    }
}
