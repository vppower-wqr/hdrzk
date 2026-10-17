const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');
const source = fs.readFileSync(path.join(__dirname, '../docs/rezka-fi-auth.js'), 'utf8');
const GUEST = '<html><body><form id="check-form"><input name="login_name"><input name="login_password" type="password"></form></body></html>';
const PREMIUM = '<html><body class="other b-premium_user__body"><a href="/logout/">Выйти</a></body></html>';
const LOGGED = '<html><body><a href="https://rezka.fi/logout/">Выйти</a></body></html>';
const testPassword = 'fixture-pass &+=Ю';

function harness(responder, options = {}) {
    const state = { params: [], components: [], notices: [], requests: [], menu: null,
        input: null, events: {}, writes: [], focus: [] };
    class XHR {
        constructor() { this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(key, value) { this.headers[key] = value; }
        send(body) {
            state.requests.push({ method: this.method, url: this.url, body,
                credentials: this.withCredentials, headers: this.headers });
            const result = responder(new URL(this.url).pathname, body, this.method);
            if (result.pending) return;
            if (result.error) { this.onerror(); return; }
            this.status = result.status || 200;
            this.responseURL = result.url || this.url;
            this.responseText = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
            this.onload();
        }
    }
    const select = {
        show(menu) { state.menu = menu; },
        hide() { state.menu = null; },
        closeAll() { state.menu = null; },
        close() { const menu = state.menu; state.menu = null; if (menu && menu.onBack) menu.onBack(); }
    };
    if (options.legacy) delete select.closeAll;
    const context = {
        window: { appready: !options.deferred }, DOMParser, XMLHttpRequest: XHR,
        Lampa: {
            SettingsApi: { addComponent(value) { state.components.push(value); }, addParam(value) { state.params.push(value); } },
            Storage: { field() { return options.noEmail ? '' : 'fixture@example.test'; },
                set(key, value) { state.writes.push({ key, value }); } },
            Noty: { show(message) { state.notices.push(message); } },
            Controller: { toggle(name) { state.focus.push(name); } },
            Select: select,
            Input: { edit(params, callback) { state.input = { params, callback }; } },
            Listener: { follow(name, handler) { state.events[name] = handler; } }
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    function click(suffix) {
        state.params.find(p => p.param.name === 'rezka_fi_auth_' + suffix).onChange();
    }
    function choose(action) {
        const menu = state.menu;
        state.menu = null;
        menu.onSelect(menu.items.find(i => i.action === action));
    }
    return { state, context, click, choose,
        login() { click('login'); state.input.callback(testPassword); choose('login'); },
        back() { select.close(); } };
}

function goodLogin(endpoint) {
    return endpoint === '/ajax/login/' ? { body: { success: true } } : { body: PREMIUM };
}

test('fixed-origin credentialed login verifies real Premium page and never stores password', () => {
    const h = harness(goodLogin);
    h.login();
    assert.deepEqual(h.state.requests.map(r => new URL(r.url).origin + new URL(r.url).pathname), ['https://rezka.fi/ajax/login/', 'https://rezka.fi/']);
    assert.ok(new URL(h.state.requests[1].url).searchParams.has('_rzfi_auth'));
    assert.ok(h.state.requests.every(r => r.credentials === true));
    const form = new URLSearchParams(h.state.requests[0].body);
    assert.equal(form.get('login_name'), 'fixture@example.test');
    assert.equal(form.get('login_password'), testPassword);
    assert.equal(form.get('login_not_save'), '0');
    assert.equal(h.state.writes.length, 0);
    assert.equal(h.state.input.params.password, true);
    assert.equal(h.state.input.params.nosave, true);
    assert.equal(h.state.notices.at(-1), 'Сессия rezka.fi подтверждена. Premium подтверждён.');
    assert.ok(h.state.notices.every(s => !s.includes(testPassword)));
});

test('Input callback on Back cannot submit a partly entered password', () => {
    const h = harness(goodLogin);
    h.click('login');
    h.state.input.callback('partly-entered');
    assert.equal(h.state.requests.length, 0);
    h.back();
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.focus.at(-1), 'settings_component');
});

test('explicit cancel and empty input do not contact the site', () => {
    const h = harness(goodLogin);
    h.click('login'); h.state.input.callback('temporary'); h.choose('cancel');
    h.click('login'); h.state.input.callback('');
    assert.equal(h.state.requests.length, 0);
});

test('successful JSON with a guest homepage is never reported as authenticated', () => {
    const h = harness(endpoint => endpoint === '/ajax/login/' ? { body: { success: true } } : { body: GUEST });
    h.login();
    assert.match(h.state.notices.at(-1), /нет подтверждённой сессии/);
});

test('a failed login is not retried and arbitrary server text is not displayed', () => {
    const h = harness(() => ({ body: { success: false, message: '<img onerror=alert(1)>' + testPassword } }));
    h.login();
    assert.equal(h.state.requests.length, 1);
    assert.match(h.state.notices.at(-1), /не подтвердил вход/);
    assert.ok(h.state.notices.every(s => !s.includes(testPassword) && !s.includes('<img')));
});

test('HTTP 200 and a script mentioning Premium are not enough to confirm login', () => {
    const h = harness(() => ({ body: '<html><body><script>var x="b-premium_user__body";</script></body></html>' }));
    h.click('check');
    assert.match(h.state.notices.at(-1), /не удалось/);
});

test('recognized logout link confirms session without inventing Premium status', () => {
    const h = harness(() => ({ body: LOGGED }));
    h.click('check');
    assert.match(h.state.notices.at(-1), /Статус Premium не определён/);
});

test('logout verifies that the site actually returned to guest state', () => {
    const h = harness(() => ({ body: GUEST }));
    h.click('logout');
    assert.deepEqual(h.state.requests.map(r => new URL(r.url).origin + new URL(r.url).pathname), ['https://rezka.fi/logout/', 'https://rezka.fi/']);
    assert.equal(h.state.notices.at(-1), 'Выход из rezka.fi подтверждён.');
    const active = harness(() => ({ body: PREMIUM }));
    active.click('logout');
    assert.match(active.state.notices.at(-1), /ещё активна/);
});

test('CORS/network errors, challenges and changed domains cannot become login success', () => {
    const cases = [
        { error: true },
        { body: '<html><body><script id="anubis_challenge">{}</script></body></html>' },
        { url: 'https://other.example.test/', body: PREMIUM }
    ];
    for (const response of cases) {
        const h = harness(() => response);
        h.click('check');
        assert.ok(!h.state.notices.at(-1).startsWith('Сессия rezka.fi подтверждена.'));
    }
});

test('busy guard and missing email prevent extra requests', () => {
    const h = harness(() => ({ pending: true }));
    h.click('check'); h.click('check'); h.click('login');
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.input, null);
    const noEmail = harness(goodLogin, { noEmail: true });
    noEmail.click('login');
    assert.equal(noEmail.state.input, null);
});

test('legacy menus and repeated ready/load events remain usable', () => {
    const h = harness(goodLogin, { deferred: true, legacy: true });
    h.state.events.app({ type: 'ready' });
    h.state.events.app({ type: 'ready' });
    vm.runInContext(source, h.context);
    assert.equal(h.state.components.length, 1);
    assert.equal(h.state.params.length, 4);
    h.login();
    assert.match(h.state.notices.at(-1), /Premium подтверждён/);
});
