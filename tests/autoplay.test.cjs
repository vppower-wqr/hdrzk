const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { harness } = require('../test-support/harness.cjs');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name + '.html'), 'utf8');
const CARD = { id: 123, name: 'Пример сериала', original_name: 'Example series' };
const EPISODES = [[1, 1], [1, 2], [1, 3], [2, 1]];

function media(season, episode, labels = ['4K', '1080p Ultra', '1080p', '720p'], formats = ['HLS', 'MP4'], revision = 1) {
    const prefix = `https://cdn.example/s${season}e${episode}-${revision}`;
    return { success: true,
        url: labels.map(label => `[${label}]` + formats.map(format => `${prefix}-${encodeURIComponent(label)}.${format === 'HLS' ? 'm3u8' : 'mp4'}`).join(' or ')).join(','),
        subtitle: `[Русский]${prefix}.vtt` };
}

function seriesHarness(options = {}) {
    let streamRequests = 0;
    const episodes = options.episodes || EPISODES;
    const h = harness((endpoint, body) => {
        if (endpoint === '/engine/ajax/search.php') return { body: fixture('search') };
        if (endpoint.endsWith('.html')) return { body: fixture('series') };
        const form = new URLSearchParams(body);
        if (form.get('action') === 'get_episodes') return { body: { success: true,
            seasons: [...new Set(episodes.map(([s]) => s))].map(s => `<li class="b-simple_season__item" data-tab_id="${s}">Сезон ${s}</li>`).join(''),
            episodes: episodes.map(([s, e]) => `<li class="b-simple_episode__item" data-season_id="${s}" data-episode_id="${e}">Серия ${e}</li>`).join('') } };
        assert.equal(form.get('action'), 'get_stream');
        streamRequests++;
        const season = Number(form.get('season')), episode = Number(form.get('episode'));
        return options.response ? options.response({ season, episode, form, count: streamRequests }) : { body: media(season, episode, undefined, undefined, streamRequests) };
    }, { playlistNext: !!options.playlistNext });
    return { ...h,
        open() { h.launch(CARD); h.choose(0); h.choose(1); h.choose(0); h.choose(0); },
        chooseQuality(label = '4K', format = 'MP4') {
            const index = h.state.menu.items.findIndex(item => item.title === label);
            assert.ok(index >= 0, 'Expected quality: ' + label);
            const item = h.state.menu.items[index];
            if (item.value.alternatives.length > 1) {
                h.longChoose(index);
                const choice = h.state.menu.items.findIndex(item => item.title.includes(' · ' + format + ' · '));
                assert.ok(choice >= 0, 'Expected format: ' + format);
                h.choose(choice);
            } else h.choose(index);
        },
        streamForms() { return h.state.requests.filter(r => r.body && new URLSearchParams(r.body).get('action') === 'get_stream').map(r => new URLSearchParams(r.body)); }
    };
}

test('ended advances exactly once, preserves voice/quality/format, carries fresh subtitles and continues to the next season', () => {
    for (const playlistNext of [false, true]) {
        const h = seriesHarness({ playlistNext });
        h.open(); h.chooseQuality('4K', 'MP4');
        assert.equal(h.streamForms().length, 1); // No prefetch of expiring signed URLs.
        assert.equal(h.state.currentPlaylist.length, 4);
        assert.equal(typeof h.state.currentPlaylist[1].url, 'function');
        for (const [season, episode] of EPISODES.slice(1)) {
            const count = h.state.played.length;
            h.ended();
            assert.equal(h.state.played.length, count + 1);
            const current = h.state.currentVideo;
            assert.equal(current.season, season);
            assert.equal(current.episode, episode);
            assert.match(current.url, new RegExp(`s${season}e${episode}-\\d+-4K\\.mp4$`));
            assert.match(current.title, /Другая озвучка/);
            assert.match(current.subtitles[0].url, new RegExp(`s${season}e${episode}-`));
            assert.match(current.timeline.hash, new RegExp(`:${season}:${episode}$`));
            assert.equal(current.card, CARD);
            assert.equal(current.quality, undefined);
            assert.equal(h.state.menu, null);
        }
        assert.ok(h.streamForms().every(form => form.get('translator_id') === '40' && form.get('id') === '333' && form.get('favs') === 'series-nonce'));
        const requests = h.state.requests.length;
        h.ended(); h.ended();
        assert.equal(h.state.requests.length, requests);
        assert.equal(h.state.played.length, 4); // Last episode never loops to the first.
        assert.equal(h.state.writes.length, 0); // Global Lampa settings remain intact.
        h.closePlayer();
        assert.equal(h.state.menu.title, 'HDRezka · качество');
        h.back();
        assert.match(h.state.menu.title, /Сезон 2/);
    }
});

test('missing quality falls back below the selected resolution and returns to the original preference when available again', () => {
    const h = seriesHarness({ response({ season, episode, count }) {
        if (season === 1 && episode === 2) return { body: media(season, episode, ['720p', '1080p'], ['MP4'], count) };
        if (season === 2) return { body: media(season, episode, ['4K'], ['HLS'], count) };
        return { body: media(season, episode, undefined, undefined, count) };
    } });
    h.open(); h.chooseQuality('4K', 'MP4');
    h.ended();
    assert.match(h.state.currentVideo.url, /1080p\.mp4$/);
    assert.match(h.state.notices.at(-1), /1080p · MP4/);
    h.ended();
    assert.match(h.state.currentVideo.url, /4K\.mp4$/);
    h.ended();
    assert.match(h.state.currentVideo.url, /4K\.m3u8$/);
    assert.match(h.state.notices.at(-1), /4K · HLS/);
});

test('Ultra preference survives a regular 1080p fallback even when higher resolutions are present', () => {
    const h = seriesHarness({ response({ season, episode, count }) {
        return { body: media(season, episode, episode === 2 ? ['1080p', '720p'] : undefined, undefined, count) };
    } });
    h.open(); h.chooseQuality('1080p Ultra', 'MP4');
    h.ended();
    assert.match(h.state.currentVideo.url, /1080p\.mp4$/);
    h.ended();
    assert.match(h.state.currentVideo.url, /1080p%20Ultra\.mp4$/);
});

test('closing the player aborts a pending next-episode request and ignores its late response', () => {
    for (const playlistNext of [false, true]) {
        const h = seriesHarness({ playlistNext, response({ season, episode }) {
            return episode === 2 ? { pending: true } : { body: media(season, episode) };
        } });
        h.open(); h.chooseQuality(); h.ended();
        const xhr = h.state.transports.at(-1);
        h.ended(); h.next();
        assert.equal(h.streamForms().length, 2);
        h.closePlayer();
        assert.equal(xhr.aborted, true);
        xhr.respond({ body: media(1, 2) });
        assert.equal(h.state.played.length, 1);
        assert.equal(h.state.menu.title, 'HDRezka · качество');
        h.back();
        h.choose(1); // Opening episode 2 manually can start a fresh request.
        assert.equal(h.streamForms().length, 3);
    }
});

test('a failed next episode stops playback without changing voice or launching an empty URL', () => {
    for (const response of [{ error: true }, { body: { success: false } }, { body: { premium_content: true, url: '[720p]https://cdn.example/preview.mp4' } }]) {
        const h = seriesHarness({ response({ season, episode }) { return episode === 2 ? response : { body: media(season, episode) }; } });
        h.open(); h.chooseQuality(); h.ended();
        assert.equal(h.state.playerOpen, false);
        assert.equal(h.state.played.length, 1);
        assert.match(h.state.notices.at(-1), /выбранной озвучке/);
        assert.match(h.state.menu.title, /Сезон 1/);
        assert.ok(h.streamForms().every(form => form.get('translator_id') === '40'));
        h.ended();
        assert.equal(h.streamForms().length, 2);
    }
});

test('a gap in the chosen translation never silently skips the missing episode', () => {
    const h = seriesHarness({ episodes: [[1, 1], [1, 3]] });
    h.open(); h.chooseQuality(); h.ended();
    assert.equal(h.streamForms().length, 1);
    assert.equal(h.state.played.length, 1);
    assert.equal(h.state.playerOpen, false);
    assert.match(h.state.notices.at(-1), /пропущена следующая серия/);
    assert.match(h.state.menu.title, /Сезон 1/);
});

test('previous and next buttons resolve fresh URLs while preserving the selected format', () => {
    const h = seriesHarness();
    h.open(); h.chooseQuality();
    const firstURL = h.state.currentVideo.url;
    h.next();
    assert.equal(h.state.currentVideo.episode, 2);
    h.previous();
    assert.equal(h.state.currentVideo.episode, 1);
    assert.notEqual(h.state.currentVideo.url, firstURL);
    assert.match(h.state.currentVideo.url, /4K\.mp4$/);
    h.next();
    assert.equal(h.state.currentVideo.episode, 2);
    assert.deepEqual(h.streamForms().map(form => form.get('episode')), ['1', '2', '1', '2']);
});

test('starting another provider cancels pending work and cannot trigger HDRezka autoplay or reopen its menus', () => {
    const h = seriesHarness({ response({ season, episode }) { return episode === 2 ? { pending: true } : { body: media(season, episode) }; } });
    h.open(); h.chooseQuality(); h.ended();
    const xhr = h.state.transports.at(-1);
    const other = { url: 'https://other.example/movie.mp4', title: 'Another provider' };
    h.externalPlay(other);
    assert.equal(xhr.aborted, true);
    xhr.respond({ body: media(1, 2) });
    h.ended();
    assert.equal(h.state.currentVideo, other);
    assert.equal(h.streamForms().length, 2);
    h.closePlayer();
    assert.equal(h.state.menu, null);
});

test('ending a standalone movie never starts a series request', () => {
    const h = harness(endpoint => ({ body: endpoint === '/engine/ajax/search.php' ? fixture('search') :
        endpoint.endsWith('.html') ? fixture('movie') : media(1, 1) }));
    h.launch({ title: 'Пример' }); h.choose(0); h.choose(0); h.choose(0);
    const count = h.state.requests.length;
    h.ended();
    assert.equal(h.state.requests.length, count);
    assert.equal(h.state.played.length, 1);
});
