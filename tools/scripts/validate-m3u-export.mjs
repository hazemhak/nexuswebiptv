#!/usr/bin/env node

/**
 * M3U Playlist Validation Script (IPTV Smarters & VLC Compatibility)
 *
 * Implements Section 8 validation checks:
 * 1. Every #EXTINF is followed by exactly one URL line.
 * 2. Series names match ^.+ S\d{2}E\d{2}$.
 * 3. Movie names match ^.+ \(\d{4}\)$ when year is present.
 * 4. No live entry has a .mp4 or .mkv URL, and no movie or series has a .m3u8 or .ts URL.
 * 5. No duplicate stream URLs.
 * 6. Ordering: All live channels first, then all movies, then all series.
 */

import fs from 'node:fs';

export function validateM3uContent(content) {
    const errors = [];
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.length === 0 || !lines[0].startsWith('#EXTM3U')) {
        errors.push('File must start with #EXTM3U');
    }

    let liveCount = 0;
    let movieCount = 0;
    let seriesCount = 0;
    const seenUrls = new Set();

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
                errors.push(`Duplicate stream URL: ${urlLine}`);
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
                    errors.push(`Series name "${displayName}" does not match ^.+ S\\d{2}E\\d{2}$`);
                }
                if (urlLine.includes('.m3u8') || urlLine.includes('.ts')) {
                    errors.push(`Series entry has live extension: ${urlLine}`);
                }
            } else if (isMovie) {
                movieCount++;
                inMovies = true;
                if (inSeries) {
                    errors.push(`Ordering violation: Movie "${displayName}" appeared after series`);
                }
                if (/\(\d{4}\)/.test(displayName) && !/^.+ \(\d{4}\)$/.test(displayName)) {
                    errors.push(`Movie name "${displayName}" does not match ^.+ \\(\\d{4}\\)$`);
                }
                if (urlLine.includes('.m3u8') || urlLine.includes('.ts')) {
                    errors.push(`Movie entry has live extension: ${urlLine}`);
                }
            } else if (isLive) {
                liveCount++;
                if (inMovies || inSeries) {
                    errors.push(`Ordering violation: Live channel "${displayName}" appeared after movies/series`);
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
        totalEntries: liveCount + movieCount + seriesCount,
    };
}

if (process.argv[1] && process.argv[1].endsWith('validate-m3u-export.mjs')) {
    const file = process.argv[2];
    if (!file) {
        console.log('Usage: node validate-m3u-export.mjs <playlist.m3u>');
        process.exit(1);
    }
    const content = fs.readFileSync(file, 'utf8');
    const result = validateM3uContent(content);
    console.log(`Validation result for ${file}:`);
    console.log(`- Valid: ${result.valid ? 'YES (PASS)' : 'NO (FAIL)'}`);
    console.log(`- Live Channels: ${result.liveCount}`);
    console.log(`- Movies (VOD):  ${result.movieCount}`);
    console.log(`- Series:        ${result.seriesCount}`);
    console.log(`- Total Items:   ${result.totalEntries}`);
    if (result.errors.length > 0) {
        console.error('Errors found:');
        for (const err of result.errors) console.error(`  ✖ ${err}`);
        process.exit(1);
    }
}
