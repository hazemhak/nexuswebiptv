import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import {
    PortalRailLink,
    PortalRailSection,
} from '@iptvnator/portal/shared/util';
import {
    type ServerConnectionState,
    ServerStorageStatusService,
    clearServerAccessToken,
    SERVER_SIGN_IN_PATH,
} from '@iptvnator/services';
import { WorkspaceShellRailLinksComponent } from '../workspace-shell-rail-links/workspace-shell-rail-links.component';

@Component({
    selector: 'app-workspace-shell-rail',
    imports: [
        MatIcon,
        MatTooltip,
        RouterLink,
        TranslatePipe,
        WorkspaceShellRailLinksComponent,
    ],
    templateUrl: './workspace-shell-rail.component.html',
    styleUrl: './workspace-shell-rail.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceShellRailComponent {
    private readonly router = inject(Router);
    private readonly serverStatus = inject(ServerStorageStatusService);

    readonly isMacOS = input(false);
    readonly workspaceLinks = input<PortalRailLink[]>([]);
    readonly primaryContextLinks = input<PortalRailLink[]>([]);
    readonly secondaryContextLinks = input<PortalRailLink[]>([]);
    readonly selectedSection = input<
        PortalRailSection | string | null | undefined
    >(null);
    readonly railProviderClass = input('rail-context-region');
    readonly isSettingsRoute = input(false);

    /** Self-hosted server storage: hidden while `inactive`. */
    readonly serverState = this.serverStatus.state;
    readonly serverIcon = computed(() => SERVER_ICONS[this.serverState()]);
    readonly serverLabelKey = computed(
        () => SERVER_LABEL_KEYS[this.serverState()]
    );

    /** Show sign out button when server storage is active and user is signed in */
    readonly canSignOut = computed(
        () => this.serverState() === 'online' || this.serverState() === 'offline'
    );

    signOut(): void {
        clearServerAccessToken();
        try {
            sessionStorage.clear();
        } catch {
            // Storage unavailable
        }
        this.serverStatus.reportUnauthorized();
        void this.router.navigateByUrl(SERVER_SIGN_IN_PATH);
    }
}

const SERVER_ICONS: Record<ServerConnectionState, string> = {
    inactive: 'dns',
    online: 'dns',
    offline: 'cloud_off',
    unauthorized: 'lock',
};

const SERVER_LABEL_KEYS: Record<ServerConnectionState, string> = {
    inactive: 'SERVER_STORAGE.STATUS_ONLINE',
    online: 'SERVER_STORAGE.STATUS_ONLINE',
    offline: 'SERVER_STORAGE.STATUS_OFFLINE',
    unauthorized: 'SERVER_STORAGE.STATUS_UNAUTHORIZED',
};
