/**
 * M3U Export Playlist Validator
 *
 * Implements validation checks specified in IPTV Smarters addendum Section 8:
 * - Every #EXTINF is followed by exactly one URL line.
 * - Series names match ^.+ S\d{2}E\d{2}$.
 * - Movie names match ^.+ \(\d{4}\)$ when year is present.
 * - No live entry has a .mp4 or .mkv URL, and no movie/series has a .m3u8 or .ts URL.
 * - No duplicate stream URLs.
 * - Strict ordering: All Live -> All Movies -> All Series.
 */

export interface M3uValidationResult {
    readonly valid: boolean;
    readonly errors: string[];
    readonly liveCount: number;
    readonly movieCount: number;
    readonly seriesCount: number;
}

export function validateM3uExportContent(content: string): M3uValidationResult {
    const errors: string[] = [];
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.length === 0 || (!lines[0].startsWith('#EXTM3U'))) {
        errors.push('File must start with #EXTM3U');
    }

    let liveCount = 0;
    let movieCount = 0;
    let seriesCount = 0;
    const seenUrls = new Set<string>();

    let inMovies = false;
    let inSeries = false;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXTINF:')) {
            const urlLine = lines[i + 1];
            if (!urlLine || urlLine.startsWith('#')) {
                errors.push(`Line ${i + 1}: #EXTINF not followed by a stream URL`);
                continue;
            }
            i++; // skip urlLine

            if (seenUrls.has(urlLine)) {
                errors.push(`Duplicate stream URL found: ${urlLine}`);
            }
            seenUrls.add(urlLine);

            const isLive = urlLine.includes('/live/') || line.includes('group-title="Live | ');
            const isMovie = urlLine.includes('/movie/') || line.includes('group-title="Movies | ');
            const isSeries = urlLine.includes('/series/') || line.includes('group-title="Series | ');

            const commaIdx = line.lastIndexOf(',');
            const displayName = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';

            if (isSeries) {
                seriesCount++;
                inSeries = true;
                if (!/^.+ S\d{2}E\d{2}$/.test(displayName)) {
                    errors.push(`Series display name "${displayName}" does not match ^.+ S\\d{2}E\\d{2}$`);
                }
                if (urlLine.includes('.m3u8') || urlLine.includes('.ts')) {
                    errors.push(`Series entry has live stream extension: ${urlLine}`);
                }
            } else if (isMovie) {
                movieCount++;
                inMovies = true;
                if (inSeries) {
                    errors.push(`Ordering violation: Movie "${displayName}" appeared after series`);
                }
                if (/\(\d{4}\)/.test(displayName) && !/^.+ \(\d{4}\)$/.test(displayName)) {
                    errors.push(`Movie display name "${displayName}" does not match ^.+ \\(\\d{4}\\)$`);
                }
                if (urlLine.includes('.m3u8') || urlLine.includes('.ts')) {
                    errors.push(`Movie entry has live stream extension: ${urlLine}`);
                }
            } else if (isLive) {
                liveCount++;
                if (inMovies || inSeries) {
                    errors.push(`Ordering violation: Live channel "${displayName}" appeared after movies or series`);
                }
                if (urlLine.includes('.mp4') || urlLine.includes('.mkv')) {
                    errors.push(`Live entry has movie/series extension: ${urlLine}`);
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        liveCount,
        movieCount,
        seriesCount,
    };
}
