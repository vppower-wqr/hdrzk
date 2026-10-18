/*
 * HDRezka 0.4.0 — account login and playback from Lampa movie cards / LG webOS.
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

    var VERSION = '0.4.0';
    var HOST = 'https://rezka.fi';
    var SECTION = 'rezka_fi_auth';
    var busy = false;
    var ready = false;
    var activeFlow = null;
    var playbackSerial = 0;
    var flowSerial = 0;
    var menuCleanup = null;

    function message(value) {
        Lampa.Noty.show(value);
    }

    function resetMenuViewport() {
        if (menuCleanup) menuCleanup();
        menuCleanup = null;
    }

    function dismiss() {
        resetMenuViewport();
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

    function resolutionRank(label) {
        var size = label.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
        if (size) return Number(size[2]);
        var pixels = label.match(/\b(\d{3,5})\s*p\b/i);
        if (pixels) return Number(pixels[1]);
        var kilo = label.match(/\b(\d+(?:\.\d+)?)\s*k\b/i);
        if (kilo) {
            var heights = { '2': 1440, '4': 2160, '8': 4320 };
            return heights[kilo[1]] || Number(kilo[1]) * 540;
        }
        if (/\bUHD\b/i.test(label)) return 2160;
        if (/\b(?:Full\s*HD|FHD)\b/i.test(label)) return 1080;
        if (/\bHD\b/i.test(label)) return 720;
        return 0;
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
            qualities.push({ title: entry.label + ' · ' + format, label: entry.label,
                url: entry.url, rank: resolutionRank(entry.label), ultra: /\bUltra\b/i.test(entry.label) ? 1 : 0,
                format: format, order: qualities.length });
        });
        qualities.sort(function (a, b) {
            return b.rank - a.rank || b.ultra - a.ultra || Number(b.format === 'HLS') - Number(a.format === 'HLS') || a.order - b.order;
        });
        // Different CDN links and container formats can describe one quality.
        // Keep every unique URL available through long OK, but one row per label.
        var grouped = [], byLabel = {};
        qualities.forEach(function (item) {
            var key = 'q:' + item.label.toLowerCase();
            var quality = byLabel[key];
            if (!quality) {
                quality = { title: item.label, label: item.label, rank: item.rank, ultra: item.ultra,
                    url: item.url, format: item.format, alternatives: [] };
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
        if (flow.playback) stopSeries(flow.playback);
        flow.cancelled = true;
        if (flow.task) flow.task.cancel();
        if (activeFlow === flow) activeFlow = null;
        dismiss();
        Lampa.Controller.toggle('content');
    }

    function failFlow(flow, error) {
        if (flow.cancelled) return;
        if (flow.episodeScreen && flow.episodeScreen.view && !flow.episodeScreen.closed) {
            dismiss();
            message(error);
            flow.episodeScreen.view.start();
            return;
        }
        finishFlow(flow);
        message(error);
    }

    function menu(flow, title, items, select, back, longSelect) {
        if (flow.cancelled) return;
        resetMenuViewport();
        var menuScroll = null;
        var viewport = null;
        function fitViewport() {
            // Some TV builds leave the select scroll as tall as its contents.
            // Bound only this menu, keeping Lampa's native remote/wheel scrolling.
            if (!viewport || !window.innerHeight || window.innerWidth <= 480) return;
            var top = Math.max(0, viewport.getBoundingClientRect().top);
            var height = Math.max(1, window.innerHeight - top - Math.ceil(window.innerHeight * 0.03));
            viewport.style.height = height + 'px';
            viewport.style.maxHeight = height + 'px';
            viewport.style.minHeight = '0';
            viewport.style.flex = '0 0 ' + height + 'px';
        }
        Lampa.Select.show({ title: title,
            items: items.map(function (item) { return { title: escapeHtml(item.title), subtitle: escapeHtml(item.subtitle), value: item }; }),
            onFullDraw: function (scroll) {
                menuScroll = scroll;
                var rendered = scroll.render();
                viewport = rendered && rendered[0];
                if (!viewport) return;
                var previous = { height: viewport.style.height, maxHeight: viewport.style.maxHeight,
                    minHeight: viewport.style.minHeight, flex: viewport.style.flex };
                menuCleanup = function () {
                    for (var key in previous) viewport.style[key] = previous[key];
                };
                fitViewport();
            },
            onFocus: function (item, target) {
                fitViewport();
                if (menuScroll && target) menuScroll.immediate(target, true);
            },
            onSelect: function (item) { resetMenuViewport(); if (!flow.cancelled) select(item.value); },
            onLong: function (item) {
                if (!flow.cancelled && longSelect) { resetMenuViewport(); longSelect(item.value); }
            },
            onBack: function () {
                resetMenuViewport();
                if (!flow.cancelled) { if (back) back(); else finishFlow(flow); }
            }
        });
    }

    function load(flow, title, path, data, callback) {
        if (flow.cancelled) return;
        function cancel() {
            if (flow.episodeScreen && flow.episodeScreen.view && !flow.episodeScreen.closed) {
                if (flow.task) flow.task.cancel();
                flow.task = null;
                dismiss();
                flow.episodeScreen.view.start();
            } else finishFlow(flow);
        }
        menu(flow, title, [{ title: 'Отмена' }], cancel, cancel);
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

    function episodeTimeline(movie, episode) {
        if (Lampa.Timeline && Lampa.Utils && Lampa.Utils.hash) {
            return Lampa.Timeline.view(Lampa.Utils.hash('rezka.fi:' + movie.id + ':' + (episode ? episode.season + ':' + episode.episode : 'movie')));
        }
        return null;
    }

    function videoItem(flow, movie, voice, episode) {
        var title = movie.title;
        if (episode) title += ' · S' + episode.season + ' E' + episode.episode;
        title += ' · ' + voice.title;
        var video = { title: title, card: flow.card, movie: flow.card };
        if (episode) { video.season = Number(episode.season); video.episode = Number(episode.episode); }
        var timeline = episodeTimeline(movie, episode);
        if (timeline) video.timeline = timeline;
        return video;
    }

    function seriesAlive(run) {
        return !run.stopped && !run.flow.cancelled && activeFlow === run.flow && run.flow.playback === run;
    }

    function ownsPlayer(run) {
        var current = Lampa.Player.playdata && Lampa.Player.playdata();
        return !!(current && current.rezka_fi_playback === run.id);
    }

    function stopSeries(run) {
        run.stopped = true;
        if (run.task) run.task.cancel();
        run.task = null;
        run.loading = false;
        if (run.flow.playback === run) run.flow.playback = null;
    }

    function episodeMenu(flow, movie, voice, episode, series) {
        return function () {
            if (flow.episodeScreen) flow.episodeScreen.focusKey = episode.season + ':' + episode.episode;
            var season = series.data.seasons.filter(function (item) { return item.id === episode.season; })[0];
            if (season) chooseEpisodes(flow, movie, voice, series.data, season, series.back);
            else series.back();
        };
    }

    function continuationQuality(stream, preferred) {
        var exact, same, lower, lowest;
        stream.qualities.forEach(function (item) {
            if (item.label.toLowerCase() === preferred.label.toLowerCase()) exact = item;
            if (item.rank === preferred.rank && (!same || (same.ultra !== preferred.ultra && item.ultra === preferred.ultra))) same = item;
            if (item.rank > 0 && item.rank <= preferred.rank && (!lower || item.rank > lower.rank ||
                (item.rank === lower.rank && lower.ultra !== preferred.ultra && item.ultra === preferred.ultra))) lower = item;
            if (item.rank > 0 && (!lowest || item.rank < lowest.rank)) lowest = item;
        });
        var quality = exact || same || (preferred.rank ? lower || lowest : null) || stream.qualities[0];
        var formats = quality.alternatives.filter(function (item) { return item.format === preferred.format; });
        return formats[0] || quality.alternatives[0];
    }

    function seriesError(run, text, episode) {
        if (!seriesAlive(run)) return;
        run.error = text;
        run.returnEpisode = episode;
        if (ownsPlayer(run) && Lampa.Player.close) Lampa.Player.close();
        else {
            stopSeries(run);
            message(text);
            if (!run.flow.cancelled) episodeMenu(run.flow, run.movie, run.voice, episode, run.series)();
        }
    }

    function activateEpisode(run, entry) {
        if (!seriesAlive(run)) return;
        // Signed URLs are resolved again when an earlier episode is revisited.
        if (run.current && run.current !== entry) {
            run.current.video.url = run.current.loader;
            run.current.stream = null;
        }
        run.current = entry;
    }

    function resolveEpisode(run, entry, complete) {
        if (!seriesAlive(run) || !ownsPlayer(run) || run.loading) return;
        var previous = run.current;
        if (previous && entry.index === previous.index + 1) {
            var a = previous.episode, b = entry.episode;
            if ((a.season === b.season && Number(b.episode) > Number(a.episode) + 1) ||
                (a.season !== b.season && (Number(b.season) > Number(a.season) + 1 || Number(b.episode) > 1))) {
                seriesError(run, 'В выбранной озвучке пропущена следующая серия. Выберите серию или озвучку вручную.', a);
                return;
            }
        }
        run.loading = true;
        var slot = { cancel: function () {} };
        run.task = slot;
        function failure(text) {
            if (run.task === slot) run.task = null;
            run.loading = false;
            seriesError(run, 'Не удалось продолжить сериал в выбранной озвучке. ' + text, entry.episode);
        }
        var task = request('/ajax/get_cdn_series/?t=' + Date.now(), formData({ id: run.movie.id,
            translator_id: run.voice.id, favs: run.movie.favs, action: 'get_stream',
            season: entry.episode.season, episode: entry.episode.episode }), function (body) {
                if (run.task === slot) run.task = null;
                if (!seriesAlive(run) || !ownsPlayer(run)) return;
                var stream, quality;
                try { stream = streamData(body); quality = continuationQuality(stream, run.preferred); }
                catch (error) { failure(error.message || 'HDRezka не вернул видео.'); return; }
                entry.video.url = quality.url;
                entry.video.subtitles = stream.subtitles;
                entry.stream = stream;
                run.loading = false;
                if (quality.label.toLowerCase() !== run.preferred.label.toLowerCase() || quality.format !== run.preferred.format) {
                    message('Для S' + entry.episode.season + ' E' + entry.episode.episode + ' выбрано ' + escapeHtml(quality.label) + ' · ' + quality.format + ': исходный вариант недоступен.');
                }
                complete();
            }, failure);
        slot.cancel = function () { if (task) task.cancel(); };
    }

    function playSeries(flow, movie, voice, episode, stream, quality, series) {
        if (flow.playback) stopSeries(flow.playback);
        var run = { id: ++playbackSerial, flow: flow, movie: movie, voice: voice, series: series,
            stopped: false, loading: false, task: null, entries: [],
            preferred: { label: quality.label, rank: quality.rank, ultra: quality.ultra, format: quality.format } };
        flow.playback = run;
        series.data.episodes.forEach(function (item, index) {
            var entry = { index: index, episode: item, video: videoItem(flow, movie, voice, item) };
            entry.video.rezka_fi_playback = run.id;
            entry.loader = function (complete) { resolveEpisode(run, entry, complete); };
            entry.video.url = entry.loader;
            entry.video.callback = function () { activateEpisode(run, entry); };
            if (item.season === episode.season && item.episode === episode.episode) {
                entry.video.url = quality.url;
                entry.video.subtitles = stream.subtitles;
                entry.stream = stream;
                run.current = entry;
            }
            run.entries.push(entry);
        });
        if (!run.current) { stopSeries(run); message('Серия отсутствует в выбранной озвучке.'); return; }
        if (Lampa.Player.callback) Lampa.Player.callback(function () {
            if (!seriesAlive(run)) return;
            var current = run.current;
            stopSeries(run);
            if (flow.cancelled) return;
            if (run.error || (flow.episodeScreen && flow.episodeScreen.view)) {
                if (run.error) message(run.error);
                episodeMenu(flow, movie, voice, run.returnEpisode || current.episode, series)();
            } else {
                chooseQuality(flow, movie, voice, current.episode, current.stream,
                    episodeMenu(flow, movie, voice, current.episode, series), series);
            }
        });
        Lampa.Player.play(run.current.video);
        Lampa.Player.playlist(run.entries.map(function (entry) { return entry.video; }));
    }

    function registerAutoplay() {
        if (Lampa.Player.listener) Lampa.Player.listener.follow('create', function (event) {
            var run = activeFlow && activeFlow.playback;
            if (run && (!event.data || event.data.rezka_fi_playback !== run.id)) stopSeries(run);
        });
        if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener && Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.next) {
            Lampa.PlayerVideo.listener.follow('ended', function () {
                var run = activeFlow && activeFlow.playback;
                if (!run || !seriesAlive(run) || !ownsPlayer(run) || run.loading) return;
                // Native autoplay already handles this event when enabled.
                // Otherwise enable it for this series without changing settings.
                if (Lampa.Storage.field('playlist_next')) return;
                if (Lampa.Select.opened && Lampa.Select.opened()) return;
                Lampa.PlayerPlaylist.next();
            });
        }
    }

    function chooseQuality(flow, movie, voice, episode, stream, back, series) {
        function play(quality) {
            dismiss();
            if (episode && series) { playSeries(flow, movie, voice, episode, stream, quality, series); return; }
            var video = videoItem(flow, movie, voice, episode);
            video.url = quality.url;
            video.subtitles = stream.subtitles;
            if (Lampa.Player.callback) Lampa.Player.callback(function () {
                if (!flow.cancelled) chooseQuality(flow, movie, voice, episode, stream, back, series);
            });
            Lampa.Player.play(video);
            Lampa.Player.playlist([video]);
        }
        menu(flow, 'HDRezka · качество', stream.qualities, play, back, function (quality) {
            if (quality.alternatives.length < 2) return;
            var counts = {};
            var variants = quality.alternatives.map(function (item) {
                counts[item.format] = (counts[item.format] || 0) + 1;
                return { title: quality.title + ' · ' + item.format + ' · Ссылка ' + counts[item.format],
                    url: item.url, label: item.label, rank: item.rank, ultra: item.ultra, format: item.format };
            });
            dismiss();
            menu(flow, 'HDRezka · ' + quality.title, variants, play, function () {
                chooseQuality(flow, movie, voice, episode, stream, back, series);
            });
        });
    }

    function getVideo(flow, movie, voice, episode, back, series) {
        var values = { id: movie.id, translator_id: voice.id, favs: movie.favs };
        if (episode) {
            values.action = 'get_stream'; values.season = episode.season; values.episode = episode.episode;
        } else {
            values.action = 'get_movie'; values.is_camrip = voice.camrip; values.is_ads = voice.ads; values.is_director = voice.director;
        }
        load(flow, 'HDRezka · получение видео…', '/ajax/get_cdn_series/?t=' + Date.now(), formData(values), function (body) {
            chooseQuality(flow, movie, voice, episode, streamData(body), back, series);
        });
    }

    function episodeNode(tag, className, text) {
        var node = document.createElement(tag);
        node.className = className || '';
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function episodeImage(card, details) {
        var path = details.still_path || card.backdrop_path || card.poster_path;
        var url = '';
        if (path && /^\/[a-z0-9_.\/-]+$/i.test(path) && Lampa.TMDB) {
            try {
                if (Lampa.TMDB.image) url = Lampa.TMDB.image('t/p/w500' + path);
                else if (Lampa.TMDB.img) url = Lampa.TMDB.img(path, 'w500');
            } catch (ignore) {}
        }
        if (!url) url = details.img || card.img || '';
        return /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : '';
    }

    function episodeTime(timeline, details) {
        var duration = Number(timeline.duration) || Number(details.runtime) * 60 || 0;
        var time = Number(timeline.time) || 0;
        if (time > 0 && duration > time) return 'осталось ' + Math.ceil((duration - time) / 60) + ' мин';
        var minutes = Math.round(duration / 60);
        if (!minutes) return '';
        return minutes < 60 ? minutes + ' мин' : Math.floor(minutes / 60) + ':' + ('0' + minutes % 60).slice(-2);
    }

    function EpisodeScreen(object) {
        var self = this;
        var flow = activeFlow && activeFlow.id === object.rezka_fi_flow ? activeFlow : null;
        var screen = flow && flow.episodeScreen;
        var card = object.card || {}, displayCard = {};
        for (var field in card) displayCard[field] = card[field];
        displayCard.title = card.title || card.name || (screen && screen.movie.title) || 'HDRezka';
        displayCard.original_title = card.original_title || card.original_name || '';
        var explorer = Lampa.Explorer ? new Lampa.Explorer({ movie: displayCard, source: card.source }) : null;
        var root = explorer ? explorer.render(true) : episodeNode('div', 'rezka-episodes rezka-episodes__fallback');
        if (explorer) { root.classList.add('rezka-episodes'); root.classList.add('rezka-episodes--explorer'); }
        var heading = episodeNode('div', 'rezka-episodes__heading');
        var toolbar = episodeNode('div', 'rezka-episodes__toolbar');
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var rows = [], last = null, dead = false;
        heading.appendChild(episodeNode('div', 'rezka-episodes__title', object.card && (object.card.name || object.card.title) || 'HDRezka'));
        heading.appendChild(toolbar);
        if (explorer) { explorer.appendHead(heading); explorer.appendFiles(scroll.render(true)); }
        else { root.appendChild(heading); root.appendChild(scroll.render(true)); }
        scroll.minus(heading);

        function alive() { return !dead && flow && !flow.cancelled && screen && !screen.closed; }
        function own() { var current = Lampa.Activity.active(); return current && current.activity === self.activity; }
        function focus(node, episode) {
            last = node;
            if (episode) {
                screen.focusKey = episode.season + ':' + episode.episode;
                scroll.update(node, true);
            }
        }
        function button(label, action) {
            var node = episodeNode('div', 'rezka-episodes__button selector', label);
            $(node).on('hover:focus', function () { focus(node); });
            $(node).on('hover:enter', action);
            toolbar.appendChild(node);
        }
        function back() {
            if (alive()) { screen.closed = true; finishFlow(flow); }
            Lampa.Activity.backward();
        }
        function metadata() {
            var key = 's' + screen.season.id;
            if (screen.metadata[key] || !Lampa.Api || !Lampa.Api.seasons || !flow.card.id) return;
            var entry = screen.metadata[key] = { episodes: {} };
            try {
                Lampa.Api.seasons(flow.card, [Number(screen.season.id)], function (result) {
                    if (!alive() || screen.view !== self) return;
                    var season = result && result[key.slice(1)];
                    (season && season.episodes || []).forEach(function (item) {
                        if (item.season_number !== undefined && String(item.season_number) !== key.slice(1)) return;
                        if (/^\d+$/.test(String(item.episode_number))) entry.episodes[String(item.episode_number)] = item;
                    });
                    if ('s' + screen.season.id === key) self.paint();
                });
            } catch (ignore) {} // Metadata is optional; HDRezka remains the episode source.
        }
        this.paint = function () {
            if (!alive()) return;
            var metadata = screen.metadata['s' + screen.season.id];
            rows.forEach(function (row) {
                var details = metadata && metadata.episodes[row.episode.episode] || {};
                row.title.textContent = clean(details.name) || row.episode.title;
                var timeline = episodeTimeline(screen.movie, row.episode) || {};
                row.time.textContent = episodeTime(timeline, details);
                var info = [];
                var rating = Number(details.vote_average);
                if (rating > 0 && rating <= 10) info.push('★ ' + rating.toFixed(1));
                if (/^\d{4}-\d{2}-\d{2}$/.test(details.air_date || '')) {
                    var date = details.air_date;
                    if (Lampa.Utils.parseTime) {
                        try { date = Lampa.Utils.parseTime(date).full; } catch (ignore) {}
                    }
                    info.push(date);
                }
                row.info.textContent = info.join('  ·  ');
                row.progress.innerHTML = '';
                if (timeline.hash && Lampa.Timeline.render) {
                    var line = Lampa.Timeline.render(timeline);
                    row.progress.appendChild(line[0] || line);
                } else {
                    var fill = episodeNode('div', 'rezka-episodes__fill');
                    fill.style.width = Math.max(0, Math.min(100, Number(timeline.percent) || 0)) + '%';
                    row.progress.appendChild(fill);
                }
                var image = episodeImage(flow.card, details);
                if (row.image.getAttribute('src') !== image) {
                    row.image.style.display = image ? '' : 'none';
                    if (image) row.image.src = image;
                }
            });
        };
        this.draw = function () {
            toolbar.innerHTML = '';
            scroll.clear(); scroll.reset(); rows = []; last = null;
            button('Назад', back);
            if (!alive()) {
                button('Открыть HDRezka', function () { launch(object.card); });
                scroll.append(episodeNode('div', 'rezka-episodes__empty', 'Выберите сериал и озвучку, чтобы загрузить серии.'));
                return;
            }
            heading.querySelector('.rezka-episodes__title').textContent = screen.movie.title;
            button('Сезон: ' + screen.season.id, function () {
                menu(flow, 'HDRezka · сезоны', screen.data.seasons, function (season) {
                    screen.focusKey = '';
                    chooseEpisodes(flow, screen.movie, screen.voice, screen.data, season, screen.back);
                }, self.start);
            });
            button('Озвучка: ' + screen.voice.title, function () {
                chooseVoices(flow, screen.movie, self.start);
            });
            toolbar.appendChild(episodeNode('div', 'rezka-episodes__source', 'Источник: HDRezka'));
            screen.data.episodes.filter(function (item) { return item.season === screen.season.id; }).forEach(function (episode) {
                var row = episodeNode('div', 'rezka-episodes__row selector');
                row.setAttribute('data-episode', episode.season + ':' + episode.episode);
                var preview = episodeNode('div', 'rezka-episodes__preview');
                var image = episodeNode('img', 'rezka-episodes__image');
                image.alt = ''; image.setAttribute('loading', 'lazy');
                image.onerror = function () { image.style.display = 'none'; };
                preview.appendChild(image);
                preview.appendChild(episodeNode('span', 'rezka-episodes__play', '▶'));
                preview.appendChild(episodeNode('span', 'rezka-episodes__number', episode.episode.length < 2 ? '0' + episode.episode : episode.episode));
                row.appendChild(preview);
                var body = episodeNode('div', 'rezka-episodes__body');
                var head = episodeNode('div', 'rezka-episodes__head');
                var title = episodeNode('div', 'rezka-episodes__name');
                var time = episodeNode('div', 'rezka-episodes__time');
                var progress = episodeNode('div', 'rezka-episodes__progress');
                var info = episodeNode('div', 'rezka-episodes__info');
                head.appendChild(title); head.appendChild(time);
                body.appendChild(head); body.appendChild(progress); body.appendChild(info);
                row.appendChild(body);
                $(row).on('hover:focus', function () { focus(row, episode); });
                $(row).on('hover:enter', function () {
                    if (!alive()) return;
                    screen.focusKey = episode.season + ':' + episode.episode;
                    getVideo(flow, screen.movie, screen.voice, episode, function () {
                        chooseEpisodes(flow, screen.movie, screen.voice, screen.data, screen.season, screen.back);
                    }, { data: screen.data, back: screen.back });
                });
                scroll.append(row);
                rows.push({ episode: episode, title: title, time: time, info: info, progress: progress, image: image });
                if (!last || screen.focusKey === episode.season + ':' + episode.episode) last = row;
            });
            self.paint();
            metadata();
        };
        this.resize = function () {
            if (Lampa.Layer) Lampa.Layer.update(root);
            var node = scroll.render(true);
            var top = Math.max(0, node.getBoundingClientRect().top);
            if (window.innerHeight && own()) node.style.height = Math.max(1, window.innerHeight - top - 12) + 'px';
        };
        this.create = function () {
            if (screen) screen.view = self;
            self.draw();
            self.activity.loader(false);
        };
        this.start = function () {
            if (dead || !own()) return;
            self.paint(); self.resize();
            function move(direction) { if (typeof Navigator !== 'undefined') Navigator.move(direction); }
            Lampa.Controller.add('content', {
                toggle: function () {
                    var region = explorer ? root.querySelector('.explorer__files') || root : root;
                    Lampa.Controller.collectionSet($(region));
                    Lampa.Controller.collectionFocus(last || false, $(region));
                },
                up: function () {
                    if (typeof Navigator !== 'undefined' && Navigator.canmove('up')) move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () { move('down'); },
                left: function () {
                    if (explorer && typeof Navigator !== 'undefined' && !Navigator.canmove('left')) explorer.toggle();
                    else move('left');
                },
                right: function () { move('right'); },
                back: back
            });
            Lampa.Controller.toggle('content');
        };
        this.render = function (js) { return js ? root : $(root); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            dead = true;
            if (screen && screen.view === self) {
                screen.view = null; screen.closed = true;
                if (flow && !flow.cancelled) finishFlow(flow);
            }
            scroll.destroy();
            if (explorer) explorer.destroy();
            else root.remove();
        };
    }

    function registerEpisodeScreen() {
        if (!Lampa.Component || !Lampa.Scroll || typeof document === 'undefined') return;
        Lampa.Component.add('rezka_fi_episodes', EpisodeScreen);
        if (document.getElementById('rezka-fi-episode-style')) return;
        var style = document.createElement('style');
        style.id = 'rezka-fi-episode-style';
        style.textContent = '.rezka-episodes{width:100%;box-sizing:border-box}.rezka-episodes__fallback{padding:0 1.6em}.rezka-episodes--explorer .rezka-episodes__title{display:none}' +
            '.rezka-episodes__heading{padding:.4em 0 .8em}.rezka-episodes__title{font-size:1.6em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:.7em}' +
            '.rezka-episodes__toolbar{display:flex;align-items:center;gap:.7em;flex-wrap:wrap}.rezka-episodes__button,.rezka-episodes__source{background:rgba(0,0,0,.2);padding:.7em 1em;border-radius:.45em;max-width:60%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}' +
            '.rezka-episodes__button.focus,.rezka-episodes__button.hover{background:#fff;color:#222}.rezka-episodes__source{opacity:.7;margin-left:auto}' +
            '.rezka-episodes__row{display:flex;position:relative;align-items:stretch;margin:0 .5em 1em;border-radius:.4em;background:rgba(0,0,0,.3);min-height:8em}' +
            '.rezka-episodes__row.focus:after,.rezka-episodes__row.hover:after{content:"";position:absolute;top:-.3em;right:-.3em;bottom:-.3em;left:-.3em;border:.2em solid #fff;border-radius:.65em;pointer-events:none}' +
            '.rezka-episodes__preview{position:relative;width:14em;min-width:14em;overflow:hidden;border-radius:.4em;background:rgba(255,255,255,.1)}' +
            '.rezka-episodes__image{width:100%;height:100%;position:absolute;object-fit:cover}.rezka-episodes__number{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;font-size:2.5em;text-shadow:0 2px 6px #000}' +
            '.rezka-episodes__play{position:absolute;top:.5em;left:.5em;z-index:1;text-shadow:0 1px 4px #000}' +
            '.rezka-episodes__body{padding:1em 1.2em;min-width:0;flex:1}.rezka-episodes__head{display:flex;align-items:center;gap:1em;min-height:2.5em}' +
            '.rezka-episodes__name{font-size:1.6em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1}.rezka-episodes__time{max-width:8em;font-size:.95em;text-align:right}' +
            '.rezka-episodes__progress{height:.25em;border-radius:.25em;background:rgba(255,255,255,.25);margin:.8em 0;overflow:hidden}.rezka-episodes__progress .time-line{height:100%;margin:0;background:transparent}.rezka-episodes__fill{height:100%;background:#fff}' +
            '.rezka-episodes__info{min-height:1.3em;opacity:.85}.rezka-episodes__empty{padding:2em}' +
            '@media(max-width:700px){.rezka-episodes__preview{width:8em;min-width:8em}.rezka-episodes__name{font-size:1.2em}.rezka-episodes__source{display:none}.rezka-episodes__button{max-width:100%}}';
        document.head.appendChild(style);
    }

    function chooseEpisodes(flow, movie, voice, data, season, back) {
        if (Lampa.Component && Lampa.Activity && Lampa.Scroll && typeof document !== 'undefined') {
            var screen = flow.episodeScreen;
            if (!screen || screen.closed) screen = flow.episodeScreen = { metadata: {}, focusKey: '' };
            screen.movie = movie; screen.voice = voice; screen.data = data; screen.season = season; screen.back = back;
            if (screen.view) { screen.view.draw(); screen.view.start(); }
            else Lampa.Activity.push({ component: 'rezka_fi_episodes', title: movie.title + ' · HDRezka',
                card: flow.card, rezka_fi_flow: flow.id, page: 1 });
            return;
        }
        var episodes = data.episodes.filter(function (item) { return item.season === season.id; });
        menu(flow, movie.title + ' · ' + season.title, episodes, function (episode) {
            getVideo(flow, movie, voice, episode, function () { chooseEpisodes(flow, movie, voice, data, season, back); }, { data: data, back: back });
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
        var flow = { id: ++flowSerial, card: card, cancelled: false, task: null };
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
        registerAutoplay();
        Lampa.Manifest.plugins = { type: 'video', name: 'HDRezka', version: VERSION,
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
        registerEpisodeScreen();
        if (Lampa.Select.listener) Lampa.Select.listener.follow('hide', resetMenuViewport);
        if (!authAlreadyLoaded) {
            Lampa.SettingsApi.addComponent({ component: SECTION, name: 'Rezka.fi: вход', icon: '' });
        }
        addButton('rezka_fi_auth_version', 'Версия плагина: ' + VERSION, function () {
            message('Загруженная версия HDRezka: ' + VERSION);
        });
        if (!authAlreadyLoaded) {
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
