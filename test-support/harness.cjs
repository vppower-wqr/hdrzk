const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '../docs/rezka-fi.js'), 'utf8');
const GUEST = '<html><body><form id="check-form"><input name="login_name"><input name="login_password" type="password"></form></body></html>';
const PREMIUM = '<html><body class="other b-premium_user__body"><a href="/logout/">Выйти</a></body></html>';
const LOGGED = '<html><body><a href="https://rezka.fi/logout/">Выйти</a></body></html>';
const testPassword = 'fixture-pass &+=Ю';

function harness(responder, options = {}) {
    const state = { params: [], components: [], notices: [], requests: [], menu: null,
        input: null, events: {}, writes: [], focus: [], plugins: [], played: [], playlists: [], transports: [] };
    class XHR {
        constructor() { this.headers = {}; state.transports.push(this); }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(key, value) { this.headers[key] = value; }
        send(body) {
            state.requests.push({ method: this.method, url: this.url, body,
                credentials: this.withCredentials, headers: this.headers });
            this.respond(responder(new URL(this.url).pathname, body, this.method));
        }
        respond(result) {
            if (result.pending) return;
            if (result.error) { this.onerror(); return; }
            this.status = result.status || 200;
            this.responseURL = result.url || this.url;
            this.responseText = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
            this.onload();
        }
        abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    }
    const select = {
        show(menu) { state.menu = menu; },
        hide() { state.menu = null; },
        closeAll() { state.menu = null; },
        close() { const menu = state.menu; state.menu = null; if (menu && menu.onBack) menu.onBack(); }
    };
    if (options.legacy) delete select.closeAll;
    function wrap(nodes) {
        return { nodes, length: nodes.length,
            find(selector) { return wrap(nodes.flatMap(n => Array.from(n.querySelectorAll(selector)))); },
            first() { return wrap(nodes.slice(0, 1)); },
            append(other) { for (const node of nodes) for (const child of other.nodes) node.appendChild(child); },
            on(name, fn) { for (const node of nodes) { node.testEvents ||= {}; node.testEvents[name] = fn; } },
            trigger(name) { for (const node of nodes) node.testEvents?.[name](); }
        };
    }
    function $(html) {
        const doc = new DOMParser().parseFromString('<html><body>' + html + '</body></html>', 'text/html');
        return wrap(Array.from(doc.body.children));
    }
    const manifest = {};
    Object.defineProperty(manifest, 'plugins', { get: () => state.plugins, set: value => state.plugins.push(value) });
    const context = {
        window: { appready: !options.deferred, rezka_fi_auth_loaded: !!options.authLoaded },
        DOMParser, XMLHttpRequest: XHR, $, atob, btoa,
        Lampa: {
            Manifest: manifest,
            Player: { play(video) { state.played.push(video); }, playlist(items) { state.playlists.push(items); },
                callback(fn) { state.playerBack = fn; } },
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
        const item = typeof action === 'number' ? menu.items[action] : menu.items.find(i => i.action === action);
        if (!item) throw new Error('Menu item not found: ' + action);
        menu.onSelect(item);
    }
    return { state, context, click, choose, render: $,
        launch(card) { state.plugins[0].onContextLauch(card); },
        login() { click('login'); state.input.callback(testPassword); choose('login'); },
        back() { select.close(); },
        reload() { vm.runInContext(source, context); } };
}

module.exports = { harness, source, GUEST, PREMIUM, LOGGED, testPassword };
