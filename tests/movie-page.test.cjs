const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { harness } = require('../test-support/harness.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name + '.html'), 'utf8');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function movieHarness(card, options = {}) {
    const sourceId = options.sourceId || '501';
    const title = options.resultTitle || card.title || card.name;
    const year = (card.release_date || card.year || '2014').toString().slice(0, 4);
    const link = options.link || `/films/drama/${sourceId}-title.html`;
    const search = options.search || `<li><a href="${link}"><span class="enty">${escape(title)}</span> (${year})</a></li>`;
    const h = harness((endpoint, body) => {
        if (endpoint === '/engine/ajax/search.php') return { body: search };
        if (endpoint.endsWith('.html')) return { body: fixture('movie').replace('initCDNMoviesEvents(222,', `initCDNMoviesEvents(${sourceId},`).replace('<h1>Пример</h1>', `<h1>${escape(title)}</h1>`) };
        assert.equal(new URLSearchParams(body).get('action'), 'get_movie');
        return { body: { success: true, url: '[1080p]https://cdn.example/movie.mp4' } };
    }, { episodeUI: true, ...options });
    return { ...h,
        open() { h.launch(card); },
        row() { return h.state.view.render(true).querySelector('[data-movie]'); },
        play() { h.render(this.row()).trigger('hover:enter'); h.choose(0); },
        voice(index) {
            const node = Array.from(h.state.view.render(true).querySelectorAll('.rezka-episodes__button')).find(node => node.textContent.startsWith('Озвучка:'));
            h.render(node).trigger('hover:enter'); h.choose(index);
        }
    };
}

test('different films, non-Latin names and animated features open a ready movie page without intermediate menus', () => {
    const cases = [
        { card: { id: 157336, title: 'Интерстеллар', original_title: 'Interstellar', release_date: '2014-11-05' }, sourceId: '2259' },
        { card: { id: 496243, title: 'Паразиты', original_title: '기생충', release_date: '2019-05-30' }, resultTitle: '기생충', sourceId: '808' },
        { card: { id: 194, title: 'Амели', original_title: "Le Fabuleux Destin d'Amélie Poulain", release_date: '2001-04-25' },
            resultTitle: 'Le Fabuleux Destin d’Amélie Poulain', sourceId: '809' },
        { card: { id: 8392, title: 'Мой сосед Тоторо', original_title: 'となりのトトロ', release_date: '1988-04-16' },
            resultTitle: 'となりのトトロ', sourceId: '810', link: '/cartoons/fantasy/810-totoro.html' }
    ];
    for (const { card, ...options } of cases) {
        const h = movieHarness(card, options); h.open();
        assert.equal(h.state.activities.at(-1).component, 'rezka_fi_episodes');
        assert.deepEqual(h.state.menus, []);
        assert.equal(h.row().getAttribute('data-movie'), options.sourceId);
        assert.equal(h.state.view.render(true).querySelector('[data-episode]'), null);
        assert.equal(h.state.metadataRequests.length, 0);
        h.play();
        assert.equal(h.state.currentVideo.episode, undefined);
        assert.equal(h.state.currentVideo.season, undefined);
        assert.equal(h.state.currentVideo.url, 'https://cdn.example/movie.mp4');
        const form = new URLSearchParams(h.state.requests.at(-1).body);
        assert.equal(form.get('id'), options.sourceId);
        assert.equal(form.get('action'), 'get_movie');
        const count = h.state.requests.length;
        h.ended();
        assert.equal(h.state.requests.length, count);
    }
});

test('movie voice stays on the page, its flags reach playback, and closing the player returns to the movie row', () => {
    const card = { id: 123, title: 'Другой фильм', release_date: '2020-01-01', runtime: 120 };
    const h = movieHarness(card, { timelines: { 'rezka.fi:501:movie': { percent: 50, time: 3600, duration: 7200 } } });
    h.open();
    assert.equal(h.row().querySelector('.rezka-episodes__time').textContent, 'осталось 60 мин');
    const count = h.state.requests.length;
    h.voice(1);
    assert.equal(h.state.menu, null);
    assert.equal(h.state.requests.length, count);
    h.play();
    const form = new URLSearchParams(h.state.requests.at(-1).body);
    assert.equal(form.get('translator_id'), '20');
    assert.equal(form.get('is_ads'), '0');
    assert.equal(form.get('is_director'), '0');
    assert.equal(h.state.currentVideo.timeline.hash, 'rezka.fi:501:movie');
    h.closePlayer();
    assert.equal(h.state.menu, null);
    assert.equal(h.state.focusedElement.getAttribute('data-movie'), '501');
    h.back(); h.open();
    assert.match(h.state.view.render(true).textContent, /Озвучка: Оригинал/);
});

test('movie and TV results with the same name/year are distinguished by card type', () => {
    const card = { id: 10, title: 'Одинаковое название', release_date: '2024-01-01', media_type: 'movie' };
    const h = movieHarness(card, { search: '<li><a href="/series/drama/999-title.html"><span class="enty">Одинаковое название</span> (2024)</a></li>' +
        '<li><a href="/films/drama/501-title.html"><span class="enty">Одинаковое название</span> (2024)</a></li>' });
    h.open();
    assert.ok(h.row());
    assert.equal(new URL(h.state.requests[1].url).pathname, '/films/drama/501-title.html');
    assert.deepEqual(h.state.menus, []);
});

test('a title-only TV card is identified from HDRezka and opens its episodes without old menus', () => {
    const card = { id: 50, title: 'Очень странные дела', year: 2016 };
    const h = harness((endpoint, body) => {
        if (endpoint === '/engine/ajax/search.php') return { body: '<li><a href="/series/fiction/600-title.html"><span class="enty">Очень странные дела</span> (2016)</a></li>' };
        if (endpoint.endsWith('.html')) return { body: fixture('series').replace('initCDNSeriesEvents(333,', 'initCDNSeriesEvents(600,') };
        assert.equal(new URLSearchParams(body).get('action'), 'get_episodes');
        return { body: { success: true, episodes: '<li class="b-simple_episode__item" data-season_id="1" data-episode_id="1">Серия 1</li>' } };
    }, { episodeUI: true });
    h.launch(card);
    assert.ok(h.state.view.render(true).querySelector('[data-episode="1:1"]'));
    assert.deepEqual(h.state.menus, []);
    assert.equal(new URLSearchParams(h.state.requests.at(-1).body).get('id'), '600');
});
