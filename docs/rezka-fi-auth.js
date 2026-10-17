/*
 * Rezka.fi Auth 0.1.0 — only account login for Lampa / LG webOS.
 * Install this JS through Lampa Extensions, then Settings > Rezka.fi: вход.
 * Study reference: https://nb557.github.io/plugins/online_mod.js (2026-10-10).
 * This is a separate implementation, with no video sources or proxy services.
 * No login/password/cookies are included. Enter credentials only on your TV.
 * MIT. Copyright (c) 2026 Rezka.fi Auth contributors.
 */
(function () {
    'use strict';
    if (window.rezka_fi_auth_loaded) return;
    window.rezka_fi_auth_loaded = true;

    var HOST = 'https://rezka.fi';
    var SECTION = 'rezka_fi_auth';
    var busy = false;
    var ready = false;

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
        if (busy) { message('Дождитесь окончания текущего запроса.'); return; }
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
            if (data === null) url += '?_rzfi_auth=' + Date.now();
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

    function init() {
        if (ready) return;
        ready = true;
        Lampa.SettingsApi.addComponent({ component: SECTION, name: 'Rezka.fi: вход', icon: '' });
        Lampa.SettingsApi.addParam({ component: SECTION,
            param: { name: 'rezka_fi_auth_email', type: 'input', values: '', default: '' },
            field: { name: 'Email или логин', description: 'Для входа только на https://rezka.fi' } });
        addButton('rezka_fi_auth_login', 'Войти на rezka.fi', askPassword);
        addButton('rezka_fi_auth_check', 'Проверить сессию rezka.fi', function () { checkSession(); });
        addButton('rezka_fi_auth_logout', 'Выйти из rezka.fi', logout);
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') init(); });
})();
