const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { harness } = require('../test-support/harness.cjs');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name + '.html'), 'utf8');
const CARD = { id: 123, name: 'Пример сериала', original_name: 'Example series', source: 'tmdb' };
const EPISODES = [[1, 1], [1, 2], [1, 3], [2, 1]];
const timelineKey = (s, e) => `rezka.fi:333:${s}:${e}`;

function screenHarness(options = {}) {
    const episodes = options.episodes || EPISODES;
    const h = harness((endpoint, body) => {
        if (endpoint === '/engine/ajax/search.php') return { body: fixture('search') };
        if (endpoint.endsWith('.html')) return { body: fixture('series') };
        const form = new URLSearchParams(body);
        if (form.get('action') === 'get_episodes') return { body: { success: true,
            seasons: [...new Set(episodes.map(([s]) => s))].map(s => `<li class="b-simple_season__item" data-tab_id="${s}">Сезон ${s}</li>`).join(''),
            episodes: episodes.map(([s, e]) => `<li class="b-simple_episode__item" data-season_id="${s}" data-episode_id="${e}">Серия ${e}</li>`).join('') } };
        assert.equal(form.get('action'), 'get_stream');
        if (options.streamResponse) return options.streamResponse(form);
        return { body: { success: true, url: `[4K]https://cdn.example/s${form.get('season')}e${form.get('episode')}.mp4` } };
    }, { episodeUI: true, ...options });
    function element(selector) { return h.state.view.render(true).querySelector(selector); }
    return { ...h, element,
        enter(selector) { const node = element(selector); assert.ok(node, selector); h.render(node).trigger('hover:enter'); },
        toolbar(label) {
            const node = Array.from(h.state.view.render(true).querySelectorAll('.rezka-episodes__button')).find(n => n.textContent.startsWith(label));
            assert.ok(node, label); h.render(node).trigger('hover:enter');
        },
        open() { h.launch(CARD); h.choose(0); h.choose(1); h.choose(0); }
    };
}

test('native episode page displays only available HDRezka episodes with catalogue metadata and the player timeline', () => {
    const h = screenHarness({ timelines: { [timelineKey(1, 1)]: { percent: 75, time: 2700, duration: 3600 } },
        seasonMetadata(card, seasons, callback) {
            callback({ 1: { episodes: [
                { season_number: 1, episode_number: 1, name: 'Большой заговор', vote_average: 8.4, runtime: 60, air_date: '2026-06-05', still_path: '/frame.jpg' },
                { season_number: 1, episode_number: 99, name: 'Недоступная серия' },
                { season_number: 2, episode_number: 2, name: 'Другой сезон' }
            ] } });
        } });
    h.open();
    assert.equal(h.state.activities.at(-1).component, 'rezka_fi_episodes');
    assert.equal(h.element('.explorer__left .explorer-card__title').textContent, CARD.name);
    assert.equal(h.state.collection.className, 'explorer__files');
    assert.equal(h.state.menu, null);
    assert.equal(h.state.view.render(true).querySelectorAll('[data-episode]').length, 3);
    assert.equal(h.element('[data-episode="1:1"] .rezka-episodes__name').textContent, 'Большой заговор');
    assert.equal(h.element('[data-episode="1:1"] .rezka-episodes__info').textContent, '★ 8.4  ·  2026-06-05');
    assert.equal(h.element('[data-episode="1:1"] .rezka-episodes__time').textContent, 'осталось 15 мин');
    assert.equal(h.element('[data-episode="1:1"] img').getAttribute('src'), 'https://image.tmdb.org/t/p/w500/frame.jpg');
    assert.equal(h.element('[data-episode="1:1"] .time-line').getAttribute('data-hash'), timelineKey(1, 1));
    assert.equal(h.element('[data-episode="1:2"] .rezka-episodes__name').textContent, 'Серия 2');
    assert.equal(h.state.metadataRequests[0].card, CARD);
    assert.equal(h.state.activities.at(-1).rezka_fi_flow > 0, true);
    assert.equal(h.state.activities.at(-1).movie, undefined); // No flow, nonce, or credentials saved in Activity.
});

test('playback from an episode row retains voice and quality across seasons and returns focus to the current episode', () => {
    const h = screenHarness(); h.open();
    h.enter('[data-episode="1:2"]'); h.choose(0);
    assert.equal(h.state.currentVideo.episode, 2);
    h.ended(); h.ended();
    assert.equal(h.state.currentVideo.season, 2);
    assert.equal(h.state.currentVideo.episode, 1);
    h.closePlayer();
    assert.equal(h.state.menu, null);
    assert.equal(h.state.focusedElement.getAttribute('data-episode'), '2:1');
    const forms = h.state.requests.filter(r => r.body && new URLSearchParams(r.body).get('action') === 'get_stream').map(r => new URLSearchParams(r.body));
    assert.ok(forms.every(form => form.get('translator_id') === '40'));
    assert.equal(h.state.currentPlaylist.length, 0);
    h.enter('[data-episode="2:1"]');
    assert.equal(h.state.menu.items[0].title, '4K');
    h.back();
    assert.equal(h.state.focusedElement.getAttribute('data-episode'), '2:1');
});

test('season and voice controls reuse the page, ignore late metadata for another season and preserve HDRezka ordering', () => {
    const h = screenHarness(); h.open();
    const firstMetadata = h.state.metadataRequests[0];
    h.toolbar('Сезон'); h.choose(1);
    assert.equal(h.state.activities.length, 2);
    assert.equal(h.element('[data-episode="2:1"] .rezka-episodes__name').textContent, 'Серия 1');
    firstMetadata.callback({ 1: { episodes: [{ season_number: 1, episode_number: 1, name: 'Первый сезон' }] } });
    assert.equal(h.element('[data-episode="2:1"] .rezka-episodes__name').textContent, 'Серия 1');
    h.toolbar('Озвучка'); h.choose(0); h.choose(0);
    assert.equal(h.state.activities.length, 2);
    h.enter('[data-episode="1:1"]'); h.choose(0);
    const form = new URLSearchParams(h.state.requests.at(-1).body);
    assert.equal(form.get('translator_id'), '30');
});

test('cancelled and failed stream requests return to the episode page and allow a retry', () => {
    let attempt = 0;
    const h = screenHarness({ streamResponse() {
        attempt++;
        return attempt === 1 ? { pending: true } : attempt === 2 ? { error: true } :
            { body: { success: true, url: '[1080p]https://cdn.example/ok.mp4' } };
    } });
    h.open(); h.enter('[data-episode="1:1"]');
    const pending = h.state.transports.at(-1);
    h.back();
    assert.equal(pending.aborted, true);
    pending.respond({ body: { success: true, url: '[4K]https://cdn.example/late.mp4' } });
    assert.equal(h.state.menu, null);
    h.enter('[data-episode="1:1"]');
    assert.equal(h.state.menu, null);
    assert.match(h.state.notices.at(-1), /Не удалось/);
    h.enter('[data-episode="1:1"]'); h.choose(0);
    assert.equal(h.state.currentVideo.url, 'https://cdn.example/ok.mp4');
});

test('remote focus scrolls through a long season and Back cancels the flow before late callbacks', () => {
    const h = screenHarness({ episodes: Array.from({ length: 80 }, (_, n) => [1, n + 1]) });
    h.open();
    for (let n = 1; n < 80; n++) h.state.controllers.content.down();
    assert.equal(h.state.focusedElement.getAttribute('data-episode'), '1:80');
    assert.equal(h.state.scrollTargets.at(-1), h.state.focusedElement);
    const metadata = h.state.metadataRequests[0];
    h.back();
    assert.equal(h.state.activities.length, 1);
    const played = h.state.played.length;
    metadata.callback({ 1: { episodes: [{ episode_number: 80, name: 'Слишком поздно' }] } });
    h.ended();
    assert.equal(h.state.played.length, played);
});

test('metadata absence and untrusted labels/images never prevent selecting an episode', () => {
    const h = screenHarness({ seasonMetadata(card, seasons, callback) {
        callback({ 1: { episodes: [{ episode_number: 1, name: '<img src=x onerror=evil()>', img: 'javascript:evil()', runtime: 45 }] } });
    } });
    h.open();
    assert.equal(h.element('[data-episode="1:1"] .rezka-episodes__name').textContent, '<img src=x onerror=evil()>');
    assert.equal(h.element('[data-episode="1:1"] .rezka-episodes__name img'), null);
    assert.equal(h.element('[data-episode="1:1"] img').getAttribute('src'), null);
    assert.equal(h.element('[data-episode="1:2"] .rezka-episodes__info').textContent, '');
    h.enter('[data-episode="1:2"]'); h.choose(0);
    assert.equal(h.state.currentVideo.episode, 2);
});

test('older builds without Explorer retain the full episode list and playback', () => {
    const h = screenHarness({ noExplorer: true }); h.open();
    assert.ok(h.state.view.render(true).classList.contains('rezka-episodes__fallback'));
    h.enter('[data-episode="1:3"]'); h.choose(0);
    assert.equal(h.state.currentVideo.episode, 3);
});
