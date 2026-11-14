import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    signal,
    OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslateModule } from '@ngx-translate/core';
import {
    PlaylistsService,
    ServerStorageStatusService,
    readServerAccessToken,
} from '@iptvnator/services';
import type { Playlist } from '@iptvnator/shared/interfaces';

@Component({
    selector: 'app-settings-m3u-export-section',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatSelectModule,
        MatSlideToggleModule,
        TranslateModule,
    ],
    templateUrl: './settings-m3u-export-section.component.html',
    styleUrl: './settings-server-section.component.scss',
})
export class SettingsM3uExportSectionComponent implements OnInit {
    private readonly playlistsService = inject(PlaylistsService);
    private readonly serverStatusService = inject(ServerStorageStatusService);

    readonly allPlaylists = signal<Playlist[]>([]);
    readonly selectedExportPlaylist = signal<string>('all');
    readonly selectedExportType = signal<string>('all');
    readonly copiedApiUrl = signal<boolean>(false);
    readonly copiedXtreamUrl = signal<boolean>(false);
    readonly serverToken = signal<string>(readServerAccessToken() || '');
    readonly proxyEnabled = signal<boolean>(this.loadProxyEnabled());
    readonly serverPlaylistCount = signal<number | null>(null);
    readonly isSyncing = signal<boolean>(false);
    readonly syncMessage = signal<string>('');

    private loadProxyEnabled(): boolean {
        if (typeof window === 'undefined') return true;
        try {
            const saved = localStorage.getItem('iptvnator_stream_proxy_enabled');
            if (saved !== null) return saved === 'true';
        } catch { /* Ignore */ }
        return !!window.__IPTVNATOR_CONFIG__?.STREAM_PROXY_ENABLED;
    }

    setProxyEnabled(enabled: boolean): void {
        this.proxyEnabled.set(enabled);
        if (typeof window !== 'undefined') {
            try {
                localStorage.setItem('iptvnator_stream_proxy_enabled', String(enabled));
                if (window.__IPTVNATOR_CONFIG__) {
                    window.__IPTVNATOR_CONFIG__.STREAM_PROXY_ENABLED = enabled;
                }
            } catch { /* Ignore */ }
        }
    }

    readonly exportedApiUrl = computed(() => {
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        const target = this.selectedExportPlaylist();
        const token =
            this.serverToken().trim() ||
            this.serverStatusService.accessToken() ||
            readServerAccessToken() ||
            '';
        const proxy = this.proxyEnabled();
        const streamType = this.selectedExportType();

        let path = '/api/m3u';
        if (token) path += `/token/${encodeURIComponent(token)}`;
        if (target && target !== 'all') path += `/${encodeURIComponent(target)}`;
        if (streamType && streamType !== 'all') path += `/type/${encodeURIComponent(streamType)}`;
        if (!proxy) path += '/direct';
        const file =
            streamType === 'live'
                ? 'live.m3u'
                : streamType === 'movie' || streamType === 'movies'
                ? 'movies.m3u'
                : streamType === 'series'
                ? 'series.m3u'
                : 'playlist.m3u';
        return `${origin}${path}/${file}`;
    });

    readonly xtreamBaseUrl = computed(() =>
        typeof window !== 'undefined' ? window.location.origin : ''
    );

    readonly selectedPlaylistDoc = computed(() => {
        const id = this.selectedExportPlaylist();
        if (!id || id === 'all') return null;
        return this.allPlaylists().find((p) => p._id === id) ?? null;
    });

    readonly xtreamUsername = computed(() => {
        const pl = this.selectedPlaylistDoc();
        if (!pl) return this.serverToken().trim() || 'admin';
        if (pl.username) return pl.username;
        const slug = (pl.title || pl.filename || pl._id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return slug || pl._id;
    });

    readonly xtreamPassword = computed(() => {
        const pl = this.selectedPlaylistDoc();
        if (pl?.password) return pl.password;
        return this.serverToken().trim() || 'admin';
    });

    ngOnInit(): void {
        this.loadPlaylists();
        void this.checkServerStatus();
    }

    private loadPlaylists(): void {
        this.playlistsService.getAllPlaylists().subscribe({
            next: (playlists: Playlist[]) => {
                this.allPlaylists.set(playlists ?? []);
            },
            error: () => {
                this.allPlaylists.set([]);
            },
        });
    }

    async checkServerStatus(): Promise<void> {
        try {
            const res = await fetch('/api/m3u/status');
            if (res.ok) {
                const data = (await res.json()) as { count?: number };
                this.serverPlaylistCount.set(data.count ?? 0);
            }
        } catch { /* ignore */ }
    }

    async syncPlaylistsToServer(): Promise<void> {
        if (this.isSyncing()) return;
        this.isSyncing.set(true);
        this.syncMessage.set('');
        try {
            const token = this.serverToken().trim();
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch('/api/m3u/sync', {
                method: 'POST',
                headers,
                body: JSON.stringify({ playlists: this.allPlaylists() }),
            });
            if (res.ok) {
                const data = (await res.json()) as { total?: number; imported?: number };
                const total = data.total ?? this.allPlaylists().length;
                this.serverPlaylistCount.set(total);
                this.syncMessage.set(`✓ Synced ${total} playlist(s) to server database.`);
            } else {
                this.syncMessage.set('Failed to sync playlists to server.');
            }
        } catch {
            this.syncMessage.set('Could not connect to server.');
        } finally {
            this.isSyncing.set(false);
        }
    }

    getPlaylistLabel(pl: Playlist): string {
        const title = pl.title || pl.filename || 'Untitled Playlist';
        if (pl.serverUrl) return `${title} (Xtream)`;
        if (pl.macAddress) return `${title} (Stalker)`;
        if (typeof pl.count === 'number' && pl.count > 0) return `${title} (${pl.count} channels)`;
        return title;
    }

    async copyExportUrl(): Promise<void> {
        const url = this.exportedApiUrl();
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            this.copiedApiUrl.set(true);
            setTimeout(() => this.copiedApiUrl.set(false), 2500);
        } catch { /* clipboard fallback */ }
    }

    async copyXtreamUrl(): Promise<void> {
        const url = this.xtreamBaseUrl();
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            this.copiedXtreamUrl.set(true);
            setTimeout(() => this.copiedXtreamUrl.set(false), 2500);
        } catch { /* clipboard fallback */ }
    }
}
