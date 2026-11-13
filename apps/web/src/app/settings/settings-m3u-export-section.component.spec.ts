import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { PlaylistsService, ServerStorageStatusService } from '@iptvnator/services';
import type { Playlist } from '@iptvnator/shared/interfaces';
import { SettingsM3uExportSectionComponent } from './settings-m3u-export-section.component';

describe('SettingsM3uExportSectionComponent', () => {
    let component: SettingsM3uExportSectionComponent;
    let fixture: ComponentFixture<SettingsM3uExportSectionComponent>;

    const mockPlaylists: Playlist[] = [
        {
            _id: 'pl-1',
            title: 'My Playlist',
            count: 10,
        } as unknown as Playlist,
    ];

    const mockPlaylistsService = {
        getAllPlaylists: jest.fn().mockReturnValue(of(mockPlaylists)),
    };

    const mockServerStatusService = {
        accessToken: jest.fn().mockReturnValue(''),
    };

    beforeEach(async () => {
        globalThis.fetch = jest.fn().mockImplementation((url: string) => {
            if (url.includes('/status')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ count: 1 }),
                });
            }
            if (url.includes('/sync')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true, total: 1 }),
                });
            }
            return Promise.reject(new Error('Unknown url'));
        }) as any;

        await TestBed.configureTestingModule({
            imports: [
                SettingsM3uExportSectionComponent,
                TranslateModule.forRoot(),
            ],
            providers: [
                { provide: PlaylistsService, useValue: mockPlaylistsService },
                { provide: ServerStorageStatusService, useValue: mockServerStatusService },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(SettingsM3uExportSectionComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('creates component and loads playlists', () => {
        expect(component).toBeTruthy();
        expect(component.allPlaylists().length).toBe(1);
        expect(component.exportedApiUrl()).toContain('playlist.m3u');
    });

    it('updates exportedApiUrl when stream type changes', () => {
        component.selectedExportType.set('live');
        expect(component.exportedApiUrl()).toContain('live.m3u');

        component.selectedExportType.set('series');
        expect(component.exportedApiUrl()).toContain('series.m3u');

        component.selectedExportType.set('movie');
        expect(component.exportedApiUrl()).toContain('movies.m3u');
    });

    it('toggles stream proxy', () => {
        component.setProxyEnabled(false);
        expect(component.proxyEnabled()).toBe(false);
        expect(component.exportedApiUrl()).toContain('/direct');

        component.setProxyEnabled(true);
        expect(component.proxyEnabled()).toBe(true);
        expect(component.exportedApiUrl()).not.toContain('/direct');
    });

    it('syncs playlists to server', async () => {
        await component.syncPlaylistsToServer();
        expect(component.syncMessage()).toContain('Synced');
        expect(component.serverPlaylistCount()).toBe(1);
    });

    it('formats playlist labels correctly', () => {
        expect(component.getPlaylistLabel(mockPlaylists[0])).toBe('My Playlist (10 channels)');
    });
});
