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
        input: null, events: {}, writes: [], focus: [], plugins: [], played: [], playlists: [], transports: [],
        currentVideo: null, currentPlaylist: [], playerOpen: false, nativePending: false };
    function emitter() {
        const handlers = {};
        return {
            follow(name, callback) { (handlers[name] ||= []).push(callback); },
            send(name, data = {}) { for (const callback of [...(handlers[name] || [])]) callback(data); }
        };
    }
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
        opened() { return !!state.menu; },
        close() { const menu = state.menu; state.menu = null; if (menu && menu.onBack) menu.onBack(); }
    };
    if (options.legacy) delete select.closeAll;
    const playerEvents = emitter(), videoEvents = emitter();
    let playerBack;
    function destroyPlayer() {
        state.playerOpen = false;
        state.currentVideo = null;
        state.currentPlaylist = [];
        state.nativePending = false;
        playerEvents.send('destroy');
    }
    const player = {
        listener: playerEvents,
        play(video) {
            let aborted = false;
            playerEvents.send('create', { data: video, abort() { aborted = true; } });
            if (aborted) return;
            state.currentVideo = video;
            state.playerOpen = true;
            state.played.push(video);
            playerEvents.send('start', video);
        },
        playlist(items) { state.currentPlaylist = items; state.playlists.push(items); },
        callback(fn) { playerBack = fn; state.playerBack = () => player.close(); },
        playdata() { return state.currentVideo; },
        opened() { return state.playerOpen; },
        close() {
            const callback = playerBack;
            destroyPlayer();
            if (callback) callback();
            playerBack = null;
        }
    };
    function currentPosition() {
        const data = state.currentVideo;
        return data ? state.currentPlaylist.findIndex(item => item.url === data.url ||
            (data.episode !== undefined && item.episode === data.episode && item.season === data.season)) : -1;
    }
    function selectPlaylistItem(item) {
        if (!item || state.nativePending) return;
        function complete() {
            const items = state.currentPlaylist;
            destroyPlayer();
            item.continue_play = true;
            player.play(item);
            player.playlist(items);
            if (item.callback) item.callback();
        }
        if (typeof item.url === 'function') {
            state.nativePending = true;
            item.url(complete);
        } else complete();
    }
    const playlist = {
        next() { selectPlaylistItem(state.currentPlaylist[currentPosition() + 1]); },
        prev() { const index = currentPosition(); if (index > 0) selectPlaylistItem(state.currentPlaylist[index - 1]); },
        get() { return state.currentPlaylist; }
    };
    // Lampa registers its native ended handler before extensions are loaded.
    videoEvents.follow('ended', () => { if (options.playlistNext && !select.opened()) playlist.next(); });
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
            Player: player,
            PlayerPlaylist: playlist,
            PlayerVideo: { listener: videoEvents },
            Utils: { hash(value) { return value; } },
            Timeline: { view(hash) { return { hash }; } },
            SettingsApi: { addComponent(value) { state.components.push(value); }, addParam(value) { state.params.push(value); } },
            Storage: { field(key) { return key === 'playlist_next' ? !!options.playlistNext : options.noEmail ? '' : 'fixture@example.test'; },
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
        longChoose(index) { const menu = state.menu; menu.onLong(menu.items[index]); },
        ended() { videoEvents.send('ended'); },
        next() { playlist.next(); },
        previous() { playlist.prev(); },
        closePlayer() { player.close(); },
        externalPlay(video) { player.play(video); player.playlist([video]); },
        login() { click('login'); state.input.callback(testPassword); choose('login'); },
        back() { select.close(); },
        reload() { vm.runInContext(source, context); } };
}

module.exports = { harness, source, GUEST, PREMIUM, LOGGED, testPassword };
