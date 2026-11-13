import { TestBed } from '@angular/core/testing';
import { StreamProxyService } from './stream-proxy.service';
import { SERVER_ACCESS_TOKEN_STORAGE_KEY } from './server-access-token';

describe('StreamProxyService', () => {
    let service: StreamProxyService;
    const originalConfig = (window as unknown as { __IPTVNATOR_CONFIG__?: unknown }).__IPTVNATOR_CONFIG__;

    beforeEach(() => {
        localStorage.clear();
        (window as unknown as { __IPTVNATOR_CONFIG__?: unknown }).__IPTVNATOR_CONFIG__ = {
            BACKEND_URL: '/api',
            STREAM_PROXY_ENABLED: true,
            ACCESS_TOKEN: 'test-token',
        };
        TestBed.configureTestingModule({});
        service = TestBed.inject(StreamProxyService);
    });

    afterEach(() => {
        (window as unknown as { __IPTVNATOR_CONFIG__?: unknown }).__IPTVNATOR_CONFIG__ = originalConfig;
        localStorage.clear();
    });

    it('rewrites stream URL with backend proxy and token', () => {
        const rewritten = service.rewrite('http://dana4kpro.com:8080/live/user/pass/123.ts');
        expect(rewritten).toBe(
            '/api/stream-proxy?url=http%3A%2F%2Fdana4kpro.com%3A8080%2Flive%2Fuser%2Fpass%2F123.ts&token=test-token'
        );
    });

    it('rewrites for external players with absolute URL', () => {
        const external = service.rewriteForExternal('http://dana4kpro.com:8080/live/user/pass/123.ts');
        expect(external).toBe(
            `${window.location.origin}/api/stream-proxy?url=http%3A%2F%2Fdana4kpro.com%3A8080%2Flive%2Fuser%2Fpass%2F123.ts&token=test-token`
        );
    });

    it('leaves non-http URLs untouched', () => {
        expect(service.rewrite('rtmp://example.test/live')).toBe('rtmp://example.test/live');
    });

    it('does not double wrap already proxied URLs', () => {
        const url = '/api/stream-proxy?url=http%3A%2F%2Fexample.com';
        expect(service.rewrite(url)).toBe(url);
    });
});
