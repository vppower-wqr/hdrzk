const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { harness, GUEST } = require('../test-support/harness.cjs');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name + '.html'), 'utf8');
const SEARCH = fixture('search');
const MOVIE = fixture('movie');
const SERIES = fixture('series');
const CARD = { id: 876, title: 'Пример', original_title: 'Sample', release_date: '2024-01-01' };
const STREAM = { success: true,
    url: '[720p]https://cdn.example/720.mp4,[1080p]https://cdn.example/1080.mp4:hls:manifest.m3u8 or https://cdn.example/1080.mp4',
    subtitle: '[Русский]https://cdn.example/ru.srt,[English]//cdn.example/en.vtt' };

function movieResponder(stream = STREAM, page = MOVIE) {
    return endpoint => {
        if (endpoint === '/engine/ajax/search.php') return { body: SEARCH };
        if (endpoint.endsWith('.html')) return { body: page };
        if (endpoint === '/ajax/get_cdn_series/') return { body: stream };
        throw new Error('Unexpected endpoint: ' + endpoint);
    };
}
function movieQuality(h) { h.launch(CARD); h.choose(0); h.choose(0); }

test('movie card action searches by title/year, sends voice flags and nonce, and opens the chosen stream in Lampa', () => {
    const h = harness(movieResponder());
    assert.equal(h.state.plugins[0].onContextMenu(CARD).name, 'Смотреть HDRezka');
    h.launch(CARD);
    assert.equal(h.state.menu.title, 'Найдено на HDRezka');
    assert.equal(h.state.menu.items.length, 2);
    assert.match(h.state.menu.items[0].subtitle, /2024/);
    h.choose(0);
    assert.equal(h.state.menu.items[0].title, 'Дубляж (RU)');
    h.choose(0);
    assert.equal(h.state.menu.items[0].title, '1080p');
    h.longChoose(0);
    h.choose(1); // Explicit MP4 choice must not be overridden by a global Lampa quality preference.
    assert.equal(h.state.played.length, 1);
    assert.equal(h.state.played[0].url, 'https://cdn.example/1080.mp4');
    assert.equal(h.state.played[0].card, CARD);
    assert.equal(h.state.played[0].quality, undefined);
    assert.equal(h.state.played[0].subtitles[1].url, 'https://cdn.example/en.vtt');
    assert.equal(h.state.playlists[0][0], h.state.played[0]);
    assert.equal(new URLSearchParams(h.state.requests[0].body).get('q'), 'Пример');
    assert.ok(new URL(h.state.requests[1].url).pathname.endsWith('222-sample-2024.html'));
    const form = new URLSearchParams(h.state.requests[2].body);
    assert.equal(form.get('id'), '222');
    assert.equal(form.get('translator_id'), '10');
    assert.equal(form.get('favs'), 'nonce &+fixture');
    assert.equal(form.get('action'), 'get_movie');
    assert.equal(form.get('is_camrip'), '0');
    assert.equal(form.get('is_ads'), '1');
    assert.equal(form.get('is_director'), '1');
    assert.ok(h.state.requests.every(r => new URL(r.url).origin === 'https://rezka.fi' && r.credentials));
    assert.equal(h.state.writes.length, 0);
    h.state.playerBack();
    assert.equal(h.state.menu.title, 'HDRezka · качество');
    h.back(); assert.match(h.state.menu.title, /озвучка/);
    h.back(); assert.equal(h.state.menu.title, 'Найдено на HDRezka');
    h.back(); assert.equal(h.state.focus.at(-1), 'content');
});

test('series uses the selected translator episode list, sorts numeric seasons/episodes and requests the selected episode', () => {
    const episodes = { success: true,
        seasons: '<li class="b-simple_season__item" data-tab_id="2">Второй сезон</li>',
        episodes: '<li class="b-simple_episode__item" data-season_id="2" data-episode_id="10">Десятая</li>' +
            '<li class="b-simple_episode__item" data-season_id="0" data-episode_id="1">Спецвыпуск</li>' +
            '<li class="b-simple_episode__item" data-season_id="2" data-episode_id="2">Вторая</li>' };
    const h = harness((endpoint, body) => {
        if (endpoint === '/engine/ajax/search.php') return { body: SEARCH };
        if (endpoint.endsWith('.html')) return { body: SERIES };
        return { body: new URLSearchParams(body).get('action') === 'get_episodes' ? episodes : STREAM };
    });
    h.launch({ name: 'Пример сериала', original_name: 'Sample series', first_air_date: '2024-01-01' });
    h.choose(0); h.choose(1); // Translator 40, not the page's default translator 30.
    assert.deepEqual(Array.from(h.state.menu.items, i => i.title), ['Сезон 0', 'Второй сезон']);
    h.choose(1);
    assert.deepEqual(Array.from(h.state.menu.items, i => i.title), ['Вторая', 'Десятая']);
    h.choose(1); h.choose(0);
    const episodeForm = new URLSearchParams(h.state.requests.at(-1).body);
    assert.equal(episodeForm.get('action'), 'get_stream');
    assert.equal(episodeForm.get('id'), '333');
    assert.equal(episodeForm.get('translator_id'), '40');
    assert.equal(episodeForm.get('favs'), 'series-nonce');
    assert.equal(episodeForm.get('season'), '2');
    assert.equal(episodeForm.get('episode'), '10');
    assert.match(h.state.played[0].title, /S2 E10/);
    h.state.playerBack(); h.back();
    assert.match(h.state.menu.title, /Второй сезон/);
    h.back(); assert.match(h.state.menu.title, /сезоны/);
    h.back(); assert.match(h.state.menu.title, /озвучка/);
});

test('encoded HDRezka playlist removes known markers and preserves Unicode quality labels', () => {
    const plain = '[1080p Тест]https://cdn.example/full.mp4';
    const encoded = Buffer.from(plain, 'utf8').toString('base64');
    const marker = '//_//' + btoa('$$!!@$$@^!@#$$@');
    const stream = { success: true, url: '#h' + encoded.slice(0, 20) + marker + marker + encoded.slice(20) };
    const h = harness(movieResponder(stream));
    movieQuality(h);
    assert.equal(h.state.menu.items[0].title, '1080p Тест');
    assert.equal(h.state.menu.items[0].subtitle, 'MP4');
    h.choose(0);
    assert.equal(h.state.played[0].url, 'https://cdn.example/full.mp4');
});

test('duplicate quality labels and formats produce one row per quality while every backup URL stays selectable', () => {
    const stream = { success: true, url:
        '[4K]https://cdn.example/4k.mp4 or https://backup.example/4k.mp4 or https://cdn.example/4k.m3u8 or https://backup.example/4k.m3u8,' +
        '[4k]https://cdn.example/4k.m3u8,' +
        '[2K]https://cdn.example/2k.m3u8 or https://backup.example/2k.m3u8 or https://cdn.example/2k.mp4 or https://backup.example/2k.mp4,' +
        '[1080p]https://cdn.example/1080.mp4' };
    const h = harness(movieResponder(stream));
    movieQuality(h);
    assert.deepEqual(Array.from(h.state.menu.items, item => item.title), ['4K', '2K', '1080p']);
    assert.match(h.state.menu.items[0].subtitle, /^HLS/);
    h.choose(0);
    assert.equal(h.state.played[0].url, 'https://cdn.example/4k.m3u8');
    h.state.playerBack();
    h.longChoose(0);
    assert.deepEqual(Array.from(h.state.menu.items, item => item.title), [
        '4K · HLS · Ссылка 1', '4K · HLS · Ссылка 2', '4K · MP4 · Ссылка 1', '4K · MP4 · Ссылка 2'
    ]);
    assert.deepEqual(Array.from(h.state.menu.items, item => item.value.url), [
        'https://cdn.example/4k.m3u8', 'https://backup.example/4k.m3u8',
        'https://cdn.example/4k.mp4', 'https://backup.example/4k.mp4'
    ]);
    h.back();
    assert.equal(h.state.menu.title, 'HDRezka · качество');
    h.longChoose(0); h.choose(3);
    assert.equal(h.state.played.at(-1).url, 'https://backup.example/4k.mp4');
    h.state.playerBack();
    assert.equal(h.state.menu.items.length, 3);
    h.back();
    assert.match(h.state.menu.title, /озвучка/);
});

test('distinct quality labels such as Ultra stay separate and a single available URL needs no submenu', () => {
    const h = harness(movieResponder({ success: true, url:
        '[1080p]https://cdn.example/normal.mp4,[1080p Ultra]https://cdn.example/ultra.mp4' }));
    movieQuality(h);
    assert.deepEqual(Array.from(h.state.menu.items, item => item.title), ['1080p Ultra', '1080p']);
    assert.equal(h.state.menu.items[0].subtitle, 'MP4');
    const menu = h.state.menu;
    h.longChoose(0);
    assert.equal(h.state.menu, menu);
    h.choose(0);
    assert.equal(h.state.played[0].url, 'https://cdn.example/ultra.mp4');
});

test('quality menu starts at the highest available resolution and puts Ultra above regular 1080p regardless of format or response order', () => {
    for (const include4K of [true, false]) {
        const h = harness(movieResponder({ success: true, url:
            '[360p]https://cdn.example/360.m3u8,[1080p]https://cdn.example/1080.m3u8,' +
            '[720p]https://cdn.example/720.mp4,[1080p Ultra]https://cdn.example/ultra.mp4,' +
            '[480p]https://cdn.example/480.m3u8' +
            (include4K ? ',[2K]https://cdn.example/2k.m3u8,[4K]https://cdn.example/4k.mp4' : '') }));
        movieQuality(h);
        const expected = ['1080p Ultra', '1080p', '720p', '480p', '360p'];
        if (include4K) expected.unshift('4K', '2K');
        assert.deepEqual(Array.from(h.state.menu.items, item => item.title), expected);
        h.choose(0);
        assert.equal(h.state.played[0].url, include4K ? 'https://cdn.example/4k.mp4' : 'https://cdn.example/ultra.mp4');
    }
});

test('pixel sizes and UHD labels rank by resolution rather than incidental codec numbers', () => {
    const h = harness(movieResponder({ success: true, url:
        '[720p H265]https://cdn.example/720.mp4,[1920x1080]https://cdn.example/1080.mp4,' +
        '[3840×2160]https://cdn.example/2160.mp4,[1440p]https://cdn.example/1440.mp4,' +
        '[HDR10 8K]https://cdn.example/8k.mp4,[UHD]https://cdn.example/uhd.mp4' }));
    movieQuality(h);
    assert.deepEqual(Array.from(h.state.menu.items, item => item.title), [
        'HDR10 8K', '3840×2160', 'UHD', '1440p', '1920x1080', '720p H265'
    ]);
});

test('missing localized result retries the original title once and stops on empty results', () => {
    const h = harness(() => ({ body: '<ul></ul>' }));
    h.launch(CARD);
    assert.deepEqual(h.state.requests.map(r => new URLSearchParams(r.body).get('q')), ['Пример', 'Sample']);
    assert.match(h.state.notices.at(-1), /ничего не найдено/);
    const noTitle = harness(() => { throw new Error('No request expected'); });
    noTitle.launch({});
    assert.equal(noTitle.state.requests.length, 0);
});

test('Cancel/Back aborts pending requests, ignores late responses and allows a new search', () => {
    for (const useBack of [false, true]) {
        const h = harness(() => ({ pending: true }));
        h.launch(CARD);
        h.launch(CARD); // While loading, do not start a second network request.
        assert.equal(h.state.requests.length, 1);
        if (useBack) h.back(); else h.choose(0);
        const xhr = h.state.transports[0];
        assert.equal(xhr.aborted, true);
        xhr.respond({ body: SEARCH });
        assert.equal(h.state.menu, null);
        assert.equal(h.state.focus.at(-1), 'content');
        h.launch(CARD);
        assert.equal(h.state.requests.length, 2);
    }
});

test('a subsequent pending request is the one cancelled after an original-title retry', () => {
    let count = 0;
    const h = harness(() => ++count === 1 ? { body: '<ul></ul>' } : { pending: true });
    h.launch(CARD);
    h.back();
    assert.equal(h.state.transports[1].aborted, true);
});

test('CORS errors, anti-bot pages, restricted titles and guest-only responses stop before playback', () => {
    const challenge = '<html><body><script id="anubis_challenge">{}</script></body></html>';
    const restricted = '<html><body><div class="b-player__restricted__block_message">Недоступно</div></body></html>';
    const cases = [
        { error: true }, { body: challenge },
        { url: 'https://other.example/films/drama/222-sample-2024.html', body: MOVIE }
    ];
    for (const response of cases) {
        const h = harness(() => response);
        h.launch(CARD);
        assert.equal(h.state.menu, null);
        assert.equal(h.state.played.length, 0);
        assert.equal(h.state.requests.length, 1);
        assert.ok(h.state.notices.length > 0);
    }
    for (const page of [restricted, GUEST]) {
        const h = harness(movieResponder(STREAM, page));
        h.launch(CARD); h.choose(0);
        assert.equal(h.state.played.length, 0);
        assert.equal(h.state.requests.length, 2);
        assert.equal(h.state.menu, null);
    }
});

test('invalid/failed stream responses and Premium preview never reach the player', () => {
    const cases = [
        { success: false, url: STREAM.url },
        { success: true },
        { url: '#zunknown' },
        { url: '#h//_//unknown' },
        { url: '[1080p]javascript:alert(1)' },
        { url: '[1080p]https://user:pass@cdn.example/full.mp4' },
        { url: '[<span class="prem-quality">1080p</span>]https://cdn.example/preview.mp4' },
        { premium_content: true, url: '[720p]https://cdn.example/preview.mp4,[1080p]https://cdn.example/preview.mp4' },
        '<html><body>Unexpected login page</body></html>'
    ];
    for (const stream of cases) {
        const h = harness(movieResponder(stream));
        movieQuality(h);
        assert.equal(h.state.played.length, 0);
        assert.equal(h.state.menu, null);
        assert.ok(h.state.notices.length > 0);
    }
});

test('empty alternate translation never borrows the default translation episodes', () => {
    const h = harness(movieResponder({ success: true }, SERIES));
    h.launch(CARD); h.choose(0); h.choose(1);
    assert.equal(h.state.menu, null);
    assert.match(h.state.notices.at(-1), /нет доступных серий/);
    const fallback = harness(movieResponder({ success: true }, SERIES));
    fallback.launch(CARD); fallback.choose(0); fallback.choose(0);
    assert.equal(fallback.state.menu.items[0].title, 'Сезон 1');
});

test('external HTML labels are escaped in menus and external/traversal search links are rejected', () => {
    const html = '<ul><li><a href="https://evil.example/films/a/1.html">external</a></li>' +
        '<li><a href="/films/../logout/a.html">traversal</a></li>' +
        '<li><a href="/films/drama/222-sample-2024.html"><span class="enty">&lt;img onerror=evil&gt;</span></a></li></ul>';
    const h = harness(() => ({ body: html }));
    h.launch(CARD);
    assert.equal(h.state.menu.items.length, 1);
    assert.equal(h.state.menu.items[0].title, '&lt;img onerror=evil&gt;');
});

test('full card adds HDRezka to modern Watch sources or legacy provider buttons, without duplicates', () => {
    for (const current of [true, false]) {
        const h = harness(movieResponder());
        const render = h.render(current ?
            '<main><div class="full-start-new__buttons"><div class="button--play"></div></div><div class="hide buttons--container"><div class="view--torrent"></div></div></main>' :
            '<main><div class="full-start__buttons"><div class="view--torrent"></div></div></main>');
        const event = { type: 'complite', data: { movie: CARD } };
        if (current) event.body = render;
        else event.object = { activity: { render: () => render } };
        h.state.events.full(event);
        h.state.events.full(event);
        assert.equal(render.find('.rezka-fi-watch').length, 1);
        assert.equal(render.find((current ? '.buttons--container' : '.full-start__buttons') + ' > .rezka-fi-watch').length, 1);
        render.find('.rezka-fi-watch').trigger('hover:enter');
        assert.equal(h.state.menu.title, 'Найдено на HDRezka');
    }
});

test('playback registers when an older auth module is already loaded, and repeated script loads stay idempotent', () => {
    const h = harness(movieResponder(), { authLoaded: true });
    h.reload();
    assert.equal(h.state.plugins.length, 1);
    assert.equal(h.state.components.length, 0);
    movieQuality(h); h.choose(0);
    assert.equal(h.state.played.length, 1);
});


test('long voice lists fit a TV viewport, follow focus to the last item and restore shared scroll styles', () => {
    const voices = Array.from({ length: 40 }, (_, index) =>
        '<li class="b-translator__item" data-translator_id="' + (index + 10) + '">Voice ' + index + '</li>').join('');
    const page = MOVIE.replace(/(<[^>]+id="translators-list"[^>]*>)[\s\S]*?(<\/ul>)/, '$1' + voices + '$2');
    for (const height of [720, 1080, 2160]) {
        const h = harness(movieResponder(STREAM, page));
        h.context.window.innerHeight = height;
        h.context.window.innerWidth = height * 16 / 9;
        h.launch(CARD); h.choose(0);
        const menu = h.state.menu;
        assert.equal(menu.items.length, 40);
        const original = { height: '', maxHeight: '', minHeight: '', flex: '' };
        const viewport = { style: { ...original }, getBoundingClientRect: () => ({ top: height * 0.15 }) };
        const focused = [];
        const scroll = { render: () => [viewport], immediate: (target, center) => focused.push({ target, center }) };
        menu.onFullDraw(scroll);
        assert.ok(parseFloat(viewport.style.height) < height * 0.85);
        const last = { name: 'last voice' };
        menu.onFocus(menu.items.at(-1), last);
        assert.equal(focused.at(-1).target, last);
        assert.equal(focused.at(-1).center, true);
        h.back();
        assert.deepEqual(viewport.style, original);
        assert.equal(h.state.menu.title, 'Найдено на HDRezka');
    }
});

test('selecting a voice clears its viewport overrides before opening the quality menu', () => {
    const h = harness(movieResponder());
    h.context.window.innerHeight = 1080;
    h.context.window.innerWidth = 1920;
    h.launch(CARD); h.choose(0);
    const viewport = { style: { height: '900px', maxHeight: '', minHeight: '', flex: '' },
        getBoundingClientRect: () => ({ top: 120 }) };
    h.state.menu.onFullDraw({ render: () => [viewport], immediate() {} });
    h.choose(0);
    assert.equal(viewport.style.height, '900px');
    assert.equal(viewport.style.maxHeight, '');
    assert.equal(h.state.menu.title, 'HDRezka · качество');
});
