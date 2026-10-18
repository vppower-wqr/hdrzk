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
        return Object.assign({ nodes, length: nodes.length,
            find(selector) { return wrap(nodes.flatMap(n => Array.from(n.querySelectorAll(selector)))); },
            first() { return wrap(nodes.slice(0, 1)); },
            append(other) { for (const node of nodes) for (const child of other.nodes) node.appendChild(child); },
            on(name, fn) { for (const node of nodes) { node.testEvents ||= {}; node.testEvents[name] = fn; } },
            trigger(name) { for (const node of nodes) node.testEvents?.[name](); }
        }, nodes);
    }
    function $(html) {
        if (html && typeof html !== 'string') return wrap([html]);
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
    if (options.episodeUI) {
        const document = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
        context.document = document;
        context.window.innerHeight = 1080;
        context.window.innerWidth = 1920;
        state.controllers = {};
        state.activities = [{ component: 'full', activity: {} }];
        state.metadataRequests = [];
        state.scrollTargets = [];
        state.timeline = options.timelines || {};
        const components = {};
        context.Lampa.Component = { add(name, component) { components[name] = component; } };
        if (!options.noExplorer) context.Lampa.Explorer = class {
            constructor(object) {
                this.html = document.createElement('div'); this.html.className = 'explorer';
                this.html.innerHTML = '<aside class="explorer__left"><div class="explorer-card__title"></div></aside>' +
                    '<section class="explorer__files"><div class="explorer__files-head"></div><div class="explorer__files-body"></div></section>';
                this.html.querySelector('.explorer-card__title').textContent = object.movie.title;
            }
            render(js) { return js ? this.html : $(this.html); }
            appendHead(node) { this.html.querySelector('.explorer__files-head').appendChild(node); }
            appendFiles(node) { this.html.querySelector('.explorer__files-body').appendChild(node); }
            toggle() { state.focus.push('explorer'); }
            destroy() { this.html.remove(); }
        };
        context.Lampa.Scroll = class {
            constructor() { this.html = document.createElement('div'); this.html.className = 'scroll';
                this.html.getBoundingClientRect = () => ({ top: 220 }); }
            render(js) { return js ? this.html : $(this.html); }
            minus() {}
            clear() { this.html.innerHTML = ''; }
            reset() {}
            append(node) { this.html.appendChild(node[0] || node); }
            update(target) { state.scrollTargets.push(target); }
            destroy() { this.html.remove(); }
        };
        context.Lampa.Controller = {
            add(name, controller) { state.controllers[name] = controller; },
            toggle(name) { state.focus.push(name); state.controllers[name]?.toggle?.(); },
            collectionSet(root) { state.collection = root[0]; },
            collectionFocus(target, root) {
                state.focusedElement = target || root[0].querySelector('.selector');
                state.focusedElement?.testEvents?.['hover:focus']?.();
            }
        };
        context.Navigator = {
            canmove() { return true; },
            move(direction) {
                const nodes = Array.from(state.collection.querySelectorAll('.selector'));
                const index = nodes.indexOf(state.focusedElement);
                const delta = direction === 'down' || direction === 'right' ? 1 : -1;
                const next = nodes[Math.max(0, Math.min(nodes.length - 1, index + delta))];
                context.Lampa.Controller.collectionFocus(next, $(state.collection));
            }
        };
        context.Lampa.Activity = {
            active() { return state.activities.at(-1); },
            push(object) {
                const view = new components[object.component](object);
                object.activity = view.activity = { loader() {} };
                object.view = view;
                view.create();
                document.body.appendChild(view.render(true));
                state.activities.push(object);
                state.view = view;
                view.start();
            },
            backward() {
                const object = state.activities.pop();
                object.view?.destroy();
                state.view = state.activities.at(-1).view;
                state.view?.start();
            }
        };
        context.Lampa.Api = { seasons(card, seasons, callback) {
            state.metadataRequests.push({ card, seasons, callback });
            if (options.seasonMetadata) options.seasonMetadata(card, seasons, callback);
        } };
        context.Lampa.TMDB = { image(path) { return 'https://image.tmdb.org/' + path; } };
        context.Lampa.Timeline = {
            view(hash) { return { hash, ...(state.timeline[hash] || {}) }; },
            render(view) {
                const node = document.createElement('div'); node.className = 'time-line';
                node.setAttribute('data-hash', view.hash);
                const fill = document.createElement('div'); fill.style.width = (view.percent || 0) + '%';
                node.appendChild(fill); return $(node);
            }
        };
    }
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
        back() { if (state.menu) select.close(); else state.controllers?.content?.back(); },
        reload() { vm.runInContext(source, context); } };
}

module.exports = { harness, source, GUEST, PREMIUM, LOGGED, testPassword };
