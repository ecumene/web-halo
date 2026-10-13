'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');

assert.match(shell, /id="online-browser"/);
assert.match(shell, /id="online-browser-list"/);
assert.match(shell, /id="online-list-public" type="checkbox" checked/);
assert.match(shell, /Public room/);
assert.match(shell, /they wait until it ends/);
assert.match(shell, /id="online-browser-heading-players"/);
assert.match(shell, />Waiting</);

function optionsFor(selectId) {
  const select = shell.match(new RegExp(
    `<select id="${selectId}"[^>]*>([\\s\\S]*?)<\\/select>`));
  assert(select, `missing #${selectId}`);
  return Array.from(select[1].matchAll(
    /<option value="(\d+)">([^<]+)<\/option>/g), match => ({
      value: match[1],
      textContent: match[2],
    }));
}

const mapOptions = optionsFor('online-map');
const modeOptions = optionsFor('online-mode');
const JOIN_LOBBY = 'ABCD-EFGH-JKLM-NPQR_abcdefghijklmnopqrstuvwxyz0123456789A.guestticketguestticket';
const JOIN_LIVE = 'ABCD-EFGH-JKLM-NPQR_abcdefghijklmnopqrstuvwxyz0123456789B.guestticketguestticket';

function element(overrides) {
  const listeners = {};
  const node = {
    children: [],
    className: '',
    dataset: {},
    disabled: false,
    hidden: false,
    open: false,
    options: [],
    style: {},
    textContent: '',
    title: '',
    type: '',
    value: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { this.children.push(child); return child; },
    close() { this.open = false; },
    contains(other) { return other === this || this.children.includes(other); },
    focus() { this.focused = true; },
    querySelectorAll: () => [],
    removeAttribute(name) { delete this[name]; },
    replaceChildren() { this.children = []; },
    select() {},
    setAttribute(name, value) { this[name] = String(value); },
    showModal() { this.open = true; },
    listeners,
  };
  return Object.assign(node, overrides || {});
}

const elements = {};
[
  'online', 'online-dialog', 'online-close', 'online-status',
  'online-description', 'online-setup', 'online-host-form', 'online-host',
  'online-join-form', 'online-code', 'online-join', 'online-invite',
  'invite-link', 'invite-copy', 'invite-copy-status', 'online-leave-host',
  'online-progress', 'online-cancel', 'online-detail', 'canvas',
  'online-wizard', 'online-wizard-map', 'online-wizard-mode',
  'online-step-map', 'online-step-mode', 'online-map-next', 'online-mode-back',
  'online-profile', 'online-player-name', 'online-profile-preview',
  'online-profile-preview-name', 'online-spartan-image',
  'online-join-confirm', 'online-join-profile', 'online-join-summary',
  'online-join-status',
  'online-map-options', 'online-mode-options', 'online-style-options',
  'player-sidebar', 'player-count', 'player-empty', 'player-sidebar-toggle',
  'online-browser', 'online-browser-list', 'online-browser-scroll',
  'online-browser-status', 'online-browser-query', 'online-browser-map',
  'online-browser-mode', 'online-browser-hide-full', 'online-browser-refresh',
  'online-browser-filters', 'online-mode-tabs', 'online-tab-browse',
  'online-tab-host', 'online-title', 'online-server-name', 'online-list-public',
  'invite-listing',
  'online-browser-heading-name', 'online-browser-heading-players',
  'online-browser-heading-queue', 'online-browser-heading-map',
  'online-browser-heading-mode',
].forEach(id => { elements[id] = element(); });

elements['online-map'] = element({ options: mapOptions, value: '9' });
elements['online-mode'] = element({ options: modeOptions, value: '2' });
elements['online-browser-map'] = element({
  options: [{ value: 'all', textContent: 'All maps' }].concat(mapOptions),
  value: 'all',
});
elements['online-browser-mode'] = element({
  options: [{ value: 'all', textContent: 'All modes' }].concat(modeOptions),
  value: 'all',
});
elements['online-list-public'].checked = true;
elements['online-server-name'].value = 'Sidewinder Night';
elements['online-invite'].hidden = true;
elements['online-progress'].hidden = true;
elements['online-step-mode'].hidden = true;
elements['online-join-confirm'].hidden = true;

const styleNames = [
  'white', 'black', 'red', 'blue', 'sage', 'yellow', 'lime', 'pink', 'purple',
  'cyan', 'cornflower', 'orange', 'teal', 'forest', 'brown', 'tan', 'maroon', 'rose',
];
const styleInputs = styleNames.map(value => element({ checked: value === 'sage', value }));
elements['online-style-options'].querySelectorAll = () => styleInputs;
elements['online-wizard-steps'] = element({ querySelectorAll: () => [] });
elements['online-map-options'].querySelectorAll = () => [];
elements['online-mode-options'].querySelectorAll = () => [];

const storage = new Map();
const socketMessages = [];
const intervals = new Map();
let nextTimer = 1;

class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    queueMicrotask(() => this.onopen && this.onopen());
  }
  close() { this.readyState = 3; }
  send(value) { socketMessages.push(JSON.parse(value)); }
}

const games = [
  {
    buildId: 'test-build',
    capacity: 16,
    hostName: 'Host',
    joinCode: JOIN_LOBBY,
    map: 'Blood Gulch',
    mode: 'Slayer',
    name: 'Quiet lobby',
    open: true,
    phase: 'lobby',
    players: 2,
    queue: 0,
  },
  {
    buildId: 'test-build',
    capacity: 16,
    hostName: 'Busy',
    joinCode: JOIN_LIVE,
    map: 'Sidewinder',
    mode: 'Capture the Flag',
    name: 'Sidewinder night',
    open: true,
    phase: 'live',
    players: 8,
    queue: 3,
  },
  {
    buildId: 'test-build',
    capacity: 16,
    hostName: 'Full',
    joinCode: 'ABCD-EFGH-JKLM-NPQR_abcdefghijklmnopqrstuvwxyz0123456789C.guestticketguestticket',
    map: 'Damnation',
    mode: 'Oddball',
    name: 'Packed room',
    open: false,
    phase: 'lobby',
    players: 16,
    queue: 0,
  },
];

const context = {
  console,
  document: {
    readyState: 'complete',
    createElement: () => element(),
    getElementById: id => elements[id] || null,
    querySelector: selector => selector === 'meta[name="halo-build-id"]' ?
      { content: 'test-build' } :
      selector === 'meta[name="halo-signaling-url"]' ?
        { content: 'https://signal.example' } : null,
    execCommand: () => true,
  },
  fetch: async (url) => {
    const path = String(url);
    if (path.includes('/v1/games')) {
      return { ok: true, status: 200, async json() { return { v: 1, games }; } };
    }
    return {
      ok: true,
      status: 201,
      async json() {
        return {
          v: 1,
          room: { id: 'room' },
          host: {
            ticket: '1234567890abcdef',
            session: {
              peerId: 'h_0123456789abcdef',
              websocketUrl: 'wss://signal.example/v1/socket',
            },
          },
          invite: {
            code: 'room.1234567890abcdef',
            url: 'https://canonical.example/#join=room.1234567890abcdef',
          },
          iceServers: [],
        };
      },
    };
  },
  HaloWebTransport: {
    configure() {},
    disconnectAll() {},
    getLocalIdentifier: () => '020000000001',
    isSupported: () => true,
  },
  history: { replaceState() {} },
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
  },
  location: {
    hash: '',
    hostname: 'halo.example',
    href: 'https://halo.example/halo.html',
    origin: 'https://halo.example',
    pathname: '/halo.html',
    port: '',
    protocol: 'https:',
    search: '',
  },
  Module: {
    _platform_web_online_get_error: () => 0,
    _platform_web_online_get_state: () => 2,
    _platform_web_online_host_configured: () => 1,
    _platform_web_online_request: () => 1,
    _platform_web_online_set_player_customization: () => 1,
    _platform_web_online_set_transport_state() {},
  },
  navigator: {},
  URL,
  URLSearchParams,
  WebSocket: FakeWebSocket,
  clearInterval: id => intervals.delete(id),
  clearTimeout() {},
  setInterval: (callback, milliseconds) => {
    const id = nextTimer++;
    intervals.set(id, { callback, milliseconds });
    return id;
  },
  setTimeout: () => nextTimer++,
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8'),
  context,
  { filename: 'online_client.js' });

function serverName(row) {
  return row.children[0].children[0].children[0].textContent;
}

function rowButtons() {
  return elements['online-browser-list'].children.map(row => {
    const action = row.children[row.children.length - 1];
    return action && action.children[0];
  });
}

async function flush() {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

(async () => {
  context.HaloOnline.runtimeReady();
  elements.online.listeners.click();
  assert.equal(elements['online-dialog'].dataset.view, 'browse');
  await flush();

  const rows = elements['online-browser-list'].children;
  assert.equal(rows.length, 3);
  assert.equal(serverName(rows[0]), 'Packed room');
  assert.match(elements['online-browser-status'].textContent, /3 servers/);
  const buttons = rowButtons();
  assert.equal(buttons[0].textContent, 'Full');
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].textContent, 'Queue');
  assert.equal(buttons[2].textContent, 'Join');

  elements['online-browser-query'].value = 'quiet';
  elements['online-browser-filters'].listeners.input();
  assert.equal(elements['online-browser-list'].children.length, 1);
  assert.equal(rowButtons()[0].textContent, 'Join');

  elements['online-browser-query'].value = '';
  elements['online-browser-hide-full'].checked = true;
  elements['online-browser-filters'].listeners.change();
  assert.equal(elements['online-browser-list'].children.length, 2);
  assert.equal(elements['online-browser-list'].children.every(row =>
    serverName(row) !== 'Packed room'), true);

  const playersHeading = elements['online-browser-heading-players'];
  const sortButton = element();
  playersHeading.children.push(sortButton);
  sortButton.closest = () => sortButton;
  playersHeading.listeners.click({ target: sortButton });
  assert.equal(serverName(elements['online-browser-list'].children[0]), 'Quiet lobby');

  elements['online-browser-hide-full'].checked = false;
  elements['online-browser-query'].value = 'sidewinder';
  elements['online-browser-filters'].listeners.input();
  rowButtons()[0].listeners.click();
  assert.equal(elements['online-dialog'].dataset.view, 'join');
  assert.match(elements['online-join-summary'].textContent, /wait until Sidewinder night ends/);
  assert.equal(elements['online-browser'].hidden, true);

  elements['online-dialog'].listeners.close();
  elements.online.listeners.click();
  assert.equal(elements['online-dialog'].dataset.view, 'browse',
    'closing a queue confirmation returns Play online to the server list');

  elements['online-tab-host'].listeners.click();
  assert.equal(elements['online-dialog'].dataset.view, 'setup');
  assert.equal(elements['online-host'].textContent, 'Host game');
  elements['online-list-public'].checked = false;
  elements['online-list-public'].listeners.change();
  assert.equal(elements['online-host'].textContent, 'Create link');
  elements['online-list-public'].checked = true;
  elements['online-list-public'].listeners.change();
  elements['online-map'].value = '9';
  elements['online-mode'].value = '2';

  await context.HaloOnline.host();
  assert(socketMessages.some(message =>
    message.type === 'listing' &&
    message.listed === true &&
    message.name === 'Sidewinder Night' &&
    message.map === 'Blood Gulch' &&
    message.mode === 'Capture the Flag' &&
    message.ticket === '1234567890abcdef'));

  console.log('online_client browser tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
