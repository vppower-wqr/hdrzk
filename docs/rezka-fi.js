/*
 * HDRezka 0.2.1 — account login and playback from Lampa movie cards / LG webOS.
 * Install through Lampa Extensions. Login: Settings > Rezka.fi: вход.
 * Study reference: https://nb557.github.io/plugins/online_mod.js (2026-10-10).
 * This is a separate implementation. Requests go directly to rezka.fi.
 * No login/password/cookies are included. Enter credentials only on your TV.
 * MIT. Copyright (c) 2026 Rezka.fi Auth contributors.
 */
(function () {
    'use strict';
    if (window.rezka_fi_player_loaded) return;
    window.rezka_fi_player_loaded = true;
    var authAlreadyLoaded = !!window.rezka_fi_auth_loaded;
    window.rezka_fi_auth_loaded = true;

    var HOST = 'https://rezka.fi';
    var SECTION = 'rezka_fi_auth';
    var busy = false;
    var ready = false;
    var activeFlow = null;

    function message(value) {
        Lampa.Noty.show(value);
    }

    function dismiss() {
        if (Lampa.Select.closeAll) Lampa.Select.closeAll();
        else Lampa.Select.hide();
    }

    function focusSettings() {
        Lampa.Controller.toggle('settings_component');
    }

    function sessionFromHtml(html) {
        var doc;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); }
        catch (ignore) { return 'unknown'; }
        if (doc.querySelector('#anubis_challenge, script[src*=".within.website"], script[src*="challenges.cloudflare.com"]')) return 'blocked';
        if (doc.body && doc.body.classList.contains('b-premium_user__body')) return 'premium';
        var links = doc.querySelectorAll('a[href]');
        for (var index = 0; index < links.length; index++) {
            var href = links[index].getAttribute('href') || '';
            if (/^(?:https:\/\/rezka\.fi)?\/logout\/?(?:[?#].*)?$/.test(href)) return 'logged';
        }
        if (doc.querySelector('input[name="login_name"]') && doc.querySelector('input[name="login_password"]')) return 'guest';
        return 'unknown';
    }

    function request(path, data, success, failure) {
        if (busy) { failure('Дождитесь окончания текущего запроса.'); return null; }
        busy = true;
        var xhr = new XMLHttpRequest();
        var finished = false;
        function fail() {
            if (finished) return;
            finished = true;
            busy = false;
            failure('Не удалось прочитать ответ rezka.fi. Возможны CORS, блокировка сторонних cookies, защита сайта или сетевая ошибка.');
        }
        try {
            var url = HOST + path;
            // A cached homepage must not be mistaken for a current login state.
            if (data === null) url += (path.indexOf('?') === -1 ? '?' : '&') + '_rzfi_auth=' + Date.now();
            xhr.open(data === null ? 'GET' : 'POST', url, true);
            xhr.withCredentials = true;
            xhr.timeout = 15000;
            if (data !== null) xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
            xhr.onload = function () {
                if (finished) return;
                if (xhr.status < 200 || xhr.status >= 300) { fail(); return; }
                if (xhr.responseURL && !/^https:\/\/rezka\.fi(?:[/?#]|$)/i.test(xhr.responseURL)) {
                    finished = true;
                    busy = false;
                    failure('Сайт перенаправил запрос на другой домен. Вход не подтверждён.');
                    return;
                }
                finished = true;
                busy = false;
                success(xhr.responseText);
            };
            xhr.onerror = fail;
            xhr.ontimeout = fail;
            xhr.onabort = fail;
            xhr.send(data);
        } catch (ignore) { fail(); }
        return { cancel: function () {
            if (finished) return;
            finished = true;
            busy = false;
            xhr.abort();
        } };
    }

    function showStatus(state) {
        if (state === 'premium') message('Сессия rezka.fi подтверждена. Premium подтверждён.');
        else if (state === 'logged') message('Сессия rezka.fi подтверждена. Статус Premium не определён.');
        else if (state === 'guest') message('В этой Lampa нет подтверждённой сессии rezka.fi.');
        else if (state === 'blocked') message('rezka.fi требует проверку доступа в браузере. Авторизация не подтверждена.');
        else message('Сайт ответил, но определить вход не удалось. Успешная авторизация не подтверждена.');
    }

    function checkSession(callback) {
        request('/', null, function (html) {
            var state = sessionFromHtml(html);
            if (callback) callback(state);
            else showStatus(state);
        }, message);
    }

    function login(email, password) {
        var data = 'login_name=' + encodeURIComponent(email) +
            '&login_password=' + encodeURIComponent(password) + '&login_not_save=0';
        password = '';
        message('Выполняется вход на rezka.fi…');
        request('/ajax/login/', data, function (body) {
            var result;
            try { result = JSON.parse(body); }
            catch (ignore) {
                // Some versions of the login endpoint redirect to a full page.
                // Check the real cookie session instead of guessing success.
                checkSession();
                return;
            }
            if (result && (result.success || result.message === 'Уже авторизован на сайте. Необходимо обновить страницу!')) {
                checkSession();
            } else {
                message('Сервис не подтвердил вход. Проверьте email, пароль и доступ к аккаунту на сайте.');
            }
        }, message);
        data = '';
    }

    function askPassword() {
        if (busy) { message('Дождитесь окончания текущего запроса.'); return; }
        var email = String(Lampa.Storage.field('rezka_fi_auth_email') || '').replace(/^\s+|\s+$/g, '');
        if (!email) { message('Сначала заполните email или логин в этом разделе настроек.'); return; }
        Lampa.Input.edit({ title: 'Пароль rezka.fi', value: '', free: true, nosave: true,
            password: true, keyboard: 'lampa' }, function (value) {
            var password = String(value || '');
            if (!password) { focusSettings(); return; }
            // Lampa.Input can call back on both OK and Back. A separate explicit
            // login action prevents submitting a partly entered password on Back.
            Lampa.Select.show({
                title: 'Вход на https://rezka.fi',
                items: [{ title: 'Войти', action: 'login' }, { title: 'Отмена', action: 'cancel' }],
                onSelect: function (item) {
                    dismiss();
                    focusSettings();
                    if (item.action === 'login') login(email, password);
                    password = '';
                },
                onBack: function () { password = ''; focusSettings(); }
            });
        });
    }

    function logout() {
        if (busy) { message('Дождитесь окончания текущего запроса.'); return; }
        message('Выполняется выход из rezka.fi…');
        request('/logout/', null, function () {
            checkSession(function (state) {
                if (state === 'guest') message('Выход из rezka.fi подтверждён.');
                else if (state === 'logged' || state === 'premium') message('Сессия ещё активна. Выход не подтверждён.');
                else showStatus(state);
            });
        }, message);
    }

    function addButton(name, title, handler) {
        Lampa.SettingsApi.addParam({ component: SECTION,
            param: { name: name, type: 'button' }, field: { name: title }, onChange: handler });
    }

    function clean(value) {
        return String(value || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function escapeHtml(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function documentFrom(html) {
        return new DOMParser().parseFromString(String(html || ''), 'text/html');
    }

    function plain(html) {
        var doc = documentFrom('<html><body>' + String(html || '') + '</body></html>');
        return clean(doc.body.textContent);
    }

    function checkedDocument(html) {
        var doc = documentFrom(html);
        if (sessionFromHtml(html) === 'blocked') throw new Error('rezka.fi требует проверку доступа в браузере.');
        if (doc.querySelector('.b-player__restricted__block_message')) {
            throw new Error('Этот фильм недоступен для просмотра на rezka.fi в текущей сессии.');
        }
        return doc;
    }

    // Only title pages on the selected site can become credentialed requests.
    function titlePath(href) {
        var path = clean(href).replace(/^https?:\/\/rezka\.fi(?=\/)/i, '');
        path = path.split(/[?#]/)[0];
        return /^\/(?:films|series|cartoons|animation|show|anime)\/[a-z0-9_\/-]+\.html$/i.test(path) ? path : '';
    }

    function searchResults(html, card) {
        var doc = checkedDocument(html);
        var nodes = doc.querySelectorAll('.b-search__live_section li a[href], li a[href], .b-content__inline_item-link > a[href]');
        var results = [], seen = {};
        var year = String(card.release_date || card.first_air_date || '').slice(0, 4);
        for (var i = 0; i < nodes.length; i++) {
            var path = titlePath(nodes[i].getAttribute('href'));
            if (!path || seen[path]) continue;
            seen[path] = true;
            var name = nodes[i].querySelector('.enty');
            var title = clean(name ? name.textContent : nodes[i].textContent);
            var detail = clean(nodes[i].textContent);
            results.push({ path: path, title: title || detail, subtitle: detail,
                rank: year && detail.indexOf(year) !== -1 ? 1 : 0 });
        }
        results.sort(function (a, b) { return b.rank - a.rank; });
        return results;
    }

    function episodeData(seasonsHtml, episodesHtml) {
        var seasons = [], episodes = [], seen = {}, names = {};
        var doc = documentFrom('<html><body>' + seasonsHtml + episodesHtml + '</body></html>');
        var nodes = doc.querySelectorAll('.b-simple_season__item[data-tab_id]');
        var i, id;
        for (i = 0; i < nodes.length; i++) {
            id = nodes[i].getAttribute('data-tab_id');
            if (/^\d+$/.test(id)) names[id] = clean(nodes[i].textContent) || 'Сезон ' + id;
        }
        nodes = doc.querySelectorAll('.b-simple_episode__item[data-season_id][data-episode_id]');
        for (i = 0; i < nodes.length; i++) {
            var season = nodes[i].getAttribute('data-season_id');
            var episode = nodes[i].getAttribute('data-episode_id');
            var key = season + ':' + episode;
            if (!/^\d+$/.test(season) || !/^\d+$/.test(episode) || seen[key]) continue;
            seen[key] = true;
            episodes.push({ season: season, episode: episode,
                title: clean(nodes[i].textContent) || 'Серия ' + episode });
            if (!seen['s' + season]) {
                seen['s' + season] = true;
                seasons.push({ id: season, title: names[season] || 'Сезон ' + season });
            }
        }
        seasons.sort(function (a, b) { return Number(a.id) - Number(b.id); });
        episodes.sort(function (a, b) { return Number(a.season) - Number(b.season) || Number(a.episode) - Number(b.episode); });
        return { seasons: seasons, episodes: episodes };
    }

    function movieData(html, fallbackTitle) {
        var doc = checkedDocument(html);
        var match = html.match(/\binitCDN(Series|Movies)Events\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?/);
        if (!match) {
            if (sessionFromHtml(html) === 'guest') throw new Error('Войдите в аккаунт: Настройки → Rezka.fi: вход.');
            throw new Error('На странице не найден плеер HDRezka. Возможно, сайт изменил формат ответа.');
        }
        var title = doc.querySelector('.b-post__title h1, h1[itemprop="name"], h1');
        var favs = doc.querySelector('#ctrl_favs');
        var movie = { id: match[2], defaultVoice: match[3], series: match[1] === 'Series',
            title: clean(title ? title.textContent : fallbackTitle), favs: favs ? favs.getAttribute('value') || '' : '', voices: [] };
        var nodes = doc.querySelectorAll('#translators-list .b-translator__item[data-translator_id]');
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i], id = node.getAttribute('data-translator_id');
            if (!/^\d+$/.test(id)) continue;
            var name = clean(node.getAttribute('title') || node.textContent) || 'Озвучка ' + id;
            var images = node.querySelectorAll('img');
            for (var j = 0; j < images.length; j++) {
                var lang = clean(images[j].getAttribute('title') || images[j].getAttribute('alt'));
                if (lang && name.indexOf(lang) === -1) name += ' (' + lang + ')';
            }
            movie.voices.push({ id: id, title: name,
                camrip: node.getAttribute('data-camrip') || '0', ads: node.getAttribute('data-ads') || '0',
                director: node.getAttribute('data-director') || '0' });
        }
        if (!movie.voices.length) movie.voices.push({ id: match[3], title: 'Основная озвучка',
            camrip: movie.series ? '0' : match[4], ads: movie.series ? '0' : match[5],
            director: movie.series ? '0' : match[6] || '0' });
        movie.initialEpisodes = episodeData(html, '');
        return movie;
    }

    function formData(values) {
        var result = [];
        for (var key in values) if (Object.prototype.hasOwnProperty.call(values, key)) {
            result.push(encodeURIComponent(key) + '=' + encodeURIComponent(values[key]));
        }
        return result.join('&');
    }

    function decodePlaylist(value) {
        value = String(value || '');
        if (value.length > 250000) throw new Error('Слишком большой ответ плеера.');
        if (value.charAt(0) !== '#') return value;
        if (value.slice(0, 2) !== '#h') throw new Error('Неизвестный формат ссылок плеера HDRezka.');
        var data = value.slice(2);
        var salts = ['$$!!@$$@^!@#$$@', '@@@@@!##!^^^', '####^!!##!@@', '^^^!@##!!##', '$$#!!@#!@##'];
        for (var i = 0; i < salts.length; i++) data = data.split('//_//' + btoa(salts[i])).join('');
        if (data.indexOf('//_//') !== -1) throw new Error('Неизвестный формат ссылок плеера HDRezka.');
        try {
            var bytes = atob(data), utf8 = '';
            for (var j = 0; j < bytes.length; j++) utf8 += '%' + ('0' + bytes.charCodeAt(j).toString(16)).slice(-2);
            return decodeURIComponent(utf8);
        } catch (ignore) { throw new Error('Не удалось прочитать ссылки плеера HDRezka.'); }
    }

    function mediaUrl(value) {
        var url = clean(value);
        if (url.slice(0, 2) === '//') url = 'https:' + url;
        return /^https?:\/\/[^/\s<>"'@?#]+(?:[/?#][^\s<>"']*)?$/i.test(url) ? url : '';
    }

    function playlistGroups(value) {
        var groups = [], regex = /\[([^\]]+)\]([^\[]+)/g, match;
        while ((match = regex.exec(value))) {
            // Premium badges can describe a guest preview, not a full stream.
            if (/prem-quality|prem-icon/i.test(match[1])) continue;
            var label = plain(match[1]);
            var links = match[2].replace(/,\s*$/, '').split(/\s+or\s+/i);
            for (var i = 0; i < links.length; i++) {
                var url = mediaUrl(links[i]);
                if (url) groups.push({ label: label, url: url });
            }
        }
        return groups;
    }

    function streamData(body) {
        var json;
        try { json = JSON.parse(body); }
        catch (ignore) { throw new Error('Сайт вернул страницу вместо видео. Проверьте вход и доступ к rezka.fi.'); }
        if (!json || json.success === false || !json.url) {
            throw new Error('HDRezka не вернул видео. Проверьте вход, доступность фильма и Premium для этой озвучки.');
        }
        var entries = playlistGroups(decodePlaylist(json.url));
        if (!entries.length) throw new Error('Нет доступных ссылок на видео. Проверьте сессию и Premium.');
        if (json.premium_content) {
            var first = '', different = false, labels = {};
            for (var i = 0; i < entries.length; i++) {
                if (/Ultra/i.test(entries[i].label) || labels[entries[i].label]) continue;
                labels[entries[i].label] = true;
                // Compare the same alternative across qualities, not HLS vs MP4.
                var file = entries[i].url;
                if (first && first !== file) different = true;
                first = file;
            }
            if (!different) throw new Error('Эта озвучка требует активной сессии HDRezka Premium. Проверьте вход в настройках.');
        }
        var seen = {}, qualities = [];
        entries.forEach(function (entry) {
            if (seen[entry.url]) return;
            seen[entry.url] = true;
            var format = /\.m3u8(?:[?#]|$)/i.test(entry.url) ? 'HLS' : /\.mp4(?:[?#]|$)/i.test(entry.url) ? 'MP4' : 'Видео';
            var number = entry.label.match(/(\d+)\s*(p|k)?/i);
            var rank = number ? Number(number[1]) * (String(number[2]).toLowerCase() === 'k' ? 1000 : 1) : 0;
            qualities.push({ title: entry.label + ' · ' + format, label: entry.label,
                url: entry.url, rank: rank, format: format, order: qualities.length });
        });
        qualities.sort(function (a, b) { return b.rank - a.rank || Number(b.format === 'HLS') - Number(a.format === 'HLS') || a.order - b.order; });
        // Different CDN links and container formats can describe one quality.
        // Keep every unique URL available through long OK, but one row per label.
        var grouped = [], byLabel = {};
        qualities.forEach(function (item) {
            var key = 'q:' + item.label.toLowerCase();
            var quality = byLabel[key];
            if (!quality) {
                quality = { title: item.label, url: item.url, format: item.format, alternatives: [] };
                byLabel[key] = quality;
                grouped.push(quality);
            }
            quality.alternatives.push(item);
        });
        grouped.forEach(function (quality) {
            quality.subtitle = quality.format;
            if (quality.alternatives.length > 1) quality.subtitle += ' · Удерживайте OK: другие варианты';
        });
        return { qualities: grouped, subtitles: playlistGroups(String(json.subtitle || '')).map(function (item) {
            return { label: item.label, url: item.url };
        }) };
    }

    function finishFlow(flow) {
        if (flow.cancelled) return;
        flow.cancelled = true;
        if (flow.task) flow.task.cancel();
        if (activeFlow === flow) activeFlow = null;
        dismiss();
        Lampa.Controller.toggle('content');
    }

    function failFlow(flow, error) {
        if (flow.cancelled) return;
        finishFlow(flow);
        message(error);
    }

    function menu(flow, title, items, select, back, longSelect) {
        if (flow.cancelled) return;
        Lampa.Select.show({ title: title,
            items: items.map(function (item) { return { title: escapeHtml(item.title), subtitle: escapeHtml(item.subtitle), value: item }; }),
            onSelect: function (item) { if (!flow.cancelled) select(item.value); },
            onLong: function (item) { if (!flow.cancelled && longSelect) longSelect(item.value); },
            onBack: function () { if (!flow.cancelled) { if (back) back(); else finishFlow(flow); } }
        });
    }

    function load(flow, title, path, data, callback) {
        if (flow.cancelled) return;
        menu(flow, title, [{ title: 'Отмена' }], function () { finishFlow(flow); });
        // A slot also works with synchronous test transports and prevents an old
        // completion from replacing a newer request's cancellation handle.
        var slot = { cancel: function () {} };
        flow.task = slot;
        var task = request(path, data, function (body) {
            if (flow.task === slot) flow.task = null;
            if (flow.cancelled) return;
            dismiss();
            try { callback(body); }
            catch (error) { failFlow(flow, error.message || 'Не удалось прочитать ответ HDRezka.'); }
        }, function (error) {
            if (flow.task === slot) flow.task = null;
            failFlow(flow, error);
        });
        slot.cancel = function () { if (task) task.cancel(); };
    }

    function chooseQuality(flow, movie, voice, episode, stream, back) {
        function play(quality) {
            dismiss();
            var title = movie.title;
            if (episode) title += ' · S' + episode.season + ' E' + episode.episode;
            title += ' · ' + voice.title;
            var video = { url: quality.url, title: title, card: flow.card, movie: flow.card, subtitles: stream.subtitles };
            if (Lampa.Timeline && Lampa.Utils && Lampa.Utils.hash) {
                video.timeline = Lampa.Timeline.view(Lampa.Utils.hash('rezka.fi:' + movie.id + ':' + (episode ? episode.season + ':' + episode.episode : 'movie')));
            }
            if (Lampa.Player.callback) Lampa.Player.callback(function () {
                if (!flow.cancelled) chooseQuality(flow, movie, voice, episode, stream, back);
            });
            Lampa.Player.play(video);
            Lampa.Player.playlist([video]);
        }
        menu(flow, 'HDRezka · качество', stream.qualities, play, back, function (quality) {
            if (quality.alternatives.length < 2) return;
            var counts = {};
            var variants = quality.alternatives.map(function (item) {
                counts[item.format] = (counts[item.format] || 0) + 1;
                return { title: quality.title + ' · ' + item.format + ' · Ссылка ' + counts[item.format], url: item.url };
            });
            dismiss();
            menu(flow, 'HDRezka · ' + quality.title, variants, play, function () {
                chooseQuality(flow, movie, voice, episode, stream, back);
            });
        });
    }

    function getVideo(flow, movie, voice, episode, back) {
        var values = { id: movie.id, translator_id: voice.id, favs: movie.favs };
        if (episode) {
            values.action = 'get_stream'; values.season = episode.season; values.episode = episode.episode;
        } else {
            values.action = 'get_movie'; values.is_camrip = voice.camrip; values.is_ads = voice.ads; values.is_director = voice.director;
        }
        load(flow, 'HDRezka · получение видео…', '/ajax/get_cdn_series/?t=' + Date.now(), formData(values), function (body) {
            chooseQuality(flow, movie, voice, episode, streamData(body), back);
        });
    }

    function chooseEpisodes(flow, movie, voice, data, season, back) {
        var episodes = data.episodes.filter(function (item) { return item.season === season.id; });
        menu(flow, movie.title + ' · ' + season.title, episodes, function (episode) {
            getVideo(flow, movie, voice, episode, function () { chooseEpisodes(flow, movie, voice, data, season, back); });
        }, back);
    }

    function chooseSeasons(flow, movie, voice, data, back) {
        menu(flow, movie.title + ' · сезоны', data.seasons, function (season) {
            chooseEpisodes(flow, movie, voice, data, season, function () { chooseSeasons(flow, movie, voice, data, back); });
        }, back);
    }

    function chooseVoices(flow, movie, back) {
        menu(flow, movie.title + ' · озвучка', movie.voices, function (voice) {
            var returnToVoices = function () { chooseVoices(flow, movie, back); };
            if (!movie.series) { getVideo(flow, movie, voice, null, returnToVoices); return; }
            load(flow, 'HDRezka · список серий…', '/ajax/get_cdn_series/?t=' + Date.now(),
                formData({ id: movie.id, translator_id: voice.id, favs: movie.favs, action: 'get_episodes' }), function (body) {
                    var json;
                    try { json = JSON.parse(body); } catch (ignore) { throw new Error('Не удалось получить список серий. Проверьте сессию rezka.fi.'); }
                    if (!json || json.success === false) throw new Error('HDRezka не вернул серии для этой озвучки.');
                    var data = episodeData(String(json.seasons || ''), String(json.episodes || ''));
                    if (!data.episodes.length && !json.episodes && voice.id === movie.defaultVoice) data = movie.initialEpisodes;
                    if (!data.episodes.length) throw new Error('Для выбранной озвучки нет доступных серий.');
                    chooseSeasons(flow, movie, voice, data, returnToVoices);
                });
        }, back);
    }

    function chooseResults(flow, results) {
        menu(flow, 'Найдено на HDRezka', results, function (result) {
            load(flow, 'HDRezka · загрузка фильма…', result.path, null, function (html) {
                chooseVoices(flow, movieData(html, result.title), function () { chooseResults(flow, results); });
            });
        });
    }

    function launch(card) {
        if (busy) { message('Дождитесь окончания текущего запроса.'); return; }
        if (activeFlow) finishFlow(activeFlow);
        card = card || {};
        var title = clean(card.title || card.name), original = clean(card.original_title || card.original_name);
        var queries = [];
        if (title) queries.push(title);
        if (original && original !== title) queries.push(original);
        if (!queries.length) { message('В карточке нет названия для поиска на HDRezka.'); return; }
        var flow = { card: card, cancelled: false, task: null };
        activeFlow = flow;
        function search(index) {
            load(flow, 'HDRezka · поиск…', '/engine/ajax/search.php', 'q=' + encodeURIComponent(queries[index]), function (html) {
                var results = searchResults(html, card);
                if (results.length) chooseResults(flow, results);
                else if (index + 1 < queries.length) search(index + 1);
                else failFlow(flow, 'На HDRezka ничего не найдено по названию: ' + (title || original));
            });
        }
        search(0);
    }

    function registerPlayback() {
        Lampa.Manifest.plugins = { type: 'video', name: 'HDRezka', version: '0.2.1',
            description: 'Просмотр через rezka.fi',
            onContextMenu: function () { return { name: 'Смотреть HDRezka', description: 'rezka.fi' }; },
            onContextLauch: launch };
        Lampa.Listener.follow('full', function (event) {
            if (event.type !== 'complite' || !event.data || !event.data.movie) return;
            var render = event.body;
            if (!render && event.object && event.object.activity) render = event.object.activity.render();
            if (!render && event.link && event.link.activity) render = event.link.activity.render();
            if (!render || render.find('.rezka-fi-watch').length) return;
            // Modern Lampa collects sources under its Watch button. Older
            // versions display provider buttons directly on the movie card.
            var target = render.find('.buttons--container').first();
            if (!target.length) target = render.find('.full-start__buttons').first();
            if (!target.length) target = render.find('.full-start-new__buttons').first();
            if (!target.length) return;
            var button = $('<div class="full-start__button selector rezka-fi-watch" data-subtitle="rezka.fi">' +
                '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span>HDRezka</span></div>');
            button.on('hover:enter', function () { launch(event.data.movie); });
            target.append(button);
        });
    }

    function init() {
        if (ready) return;
        ready = true;
        if (!authAlreadyLoaded) {
            Lampa.SettingsApi.addComponent({ component: SECTION, name: 'Rezka.fi: вход', icon: '' });
            Lampa.SettingsApi.addParam({ component: SECTION,
                param: { name: 'rezka_fi_auth_email', type: 'input', values: '', default: '' },
                field: { name: 'Email или логин', description: 'Для входа только на https://rezka.fi' } });
            addButton('rezka_fi_auth_login', 'Войти на rezka.fi', askPassword);
            addButton('rezka_fi_auth_check', 'Проверить сессию rezka.fi', function () { checkSession(); });
            addButton('rezka_fi_auth_logout', 'Выйти из rezka.fi', logout);
        }
        registerPlayback();
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') init(); });
})();
