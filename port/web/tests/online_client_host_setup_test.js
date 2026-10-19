'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');

const headerStart = shell.indexOf('<header>');
const headerEnd = shell.indexOf('</header>', headerStart);
const sidebarStart = shell.indexOf('<aside id="player-sidebar"');
const sidebarEnd = shell.indexOf('</aside>', sidebarStart);
const onlineButton = shell.indexOf('id="online"');
assert(sidebarStart >= 0 && onlineButton > sidebarStart && onlineButton < sidebarEnd,
  'Play online must live in the persistent left sidebar');
assert(onlineButton < headerStart || onlineButton > headerEnd,
  'Play online must no longer appear in the top header');
assert(!shell.slice(sidebarStart, shell.indexOf('>', sidebarStart)).includes(' hidden'),
  'the multiplayer sidebar must remain available while offline');
assert.equal(shell.includes('id="invite-share"'), false);
assert.equal(shell.includes('id="invite-code"'), false);
assert.match(shell, /class="sidebar-invite-row"[\s\S]*id="invite-link"[\s\S]*id="invite-copy"/);

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
assert.equal(mapOptions.length, 13);
assert.deepEqual(mapOptions.map(option => option.value),
  Array.from({ length: 13 }, (_, index) => String(index)));
assert.deepEqual(mapOptions.map(option => option.textContent), [
  'Battle Creek', 'Sidewinder', 'Damnation', 'Rat Race', 'Prisoner',
  "Hang 'Em High", 'Chill Out', 'Derelict', 'Boarding Action',
  'Blood Gulch', 'Wizard', 'Chiron TL-34', 'Longest',
]);
assert.deepEqual(modeOptions.map(option => option.value),
  Array.from({ length: 6 }, (_, index) => String(index)));
assert.deepEqual(modeOptions.map(option => option.textContent), [
  'Slayer', 'Team Slayer', 'Capture the Flag', 'Oddball',
  'King of the Hill', 'Race',
]);

function element(overrides) {
  const listeners = {};
  return Object.assign({
    dataset: {},
    disabled: false,
    hidden: false,
    open: false,
    options: [],
    value: '',
    textContent: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    close() { this.open = false; },
    focus() { this.focused = true; },
    removeAttribute(name) { delete this[name]; },
    select() {},
    setAttribute(name, value) { this[name] = String(value); },
    showModal() { this.open = true; },
    listeners,
  }, overrides || {});
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
  'online-profile-preview-name',
  'online-join-confirm', 'online-join-profile', 'online-join-summary',
  'online-join-status',
  'online-map-options', 'online-mode-options',
  'online-advanced-enabled', 'online-advanced-fields',
  'online-score-to-win', 'online-respawn-seconds', 'online-lives',
  'online-health-percent', 'online-infinite-grenades', 'online-shields',
  'online-invisible-players', 'online-other-players-on-radar',
  'player-sidebar', 'player-count', 'player-empty', 'player-sidebar-toggle',
].forEach(id => { elements[id] = element(); });
elements['online-score-to-win'].value = '15';
elements['online-respawn-seconds'].value = '0';
elements['online-lives'].value = '0';
elements['online-health-percent'].value = '100';
elements['online-shields'].checked = true;
elements['online-other-players-on-radar'].checked = true;
const styleNames = [
  'white', 'black', 'red', 'blue', 'sage', 'yellow', 'lime', 'pink', 'purple',
  'cyan', 'cornflower', 'orange', 'teal', 'forest', 'brown', 'tan', 'maroon', 'rose',
];
const styleInputs = styleNames.map(value => element({
  checked: value === 'sage',
  value,
}));
const wizardIndicators = [
  elements['online-wizard-map'],
  elements['online-wizard-mode'],
];
wizardIndicators.forEach((indicator, index) => {
  indicator.dataset.step = ['map', 'mode'][index];
});
elements['online-wizard-steps'] = element({
  querySelectorAll: () => wizardIndicators,
});
elements['online-style-options'] = element({
  querySelectorAll: () => styleInputs,
});
elements['online-map'] = element({ options: mapOptions, value: '0' });
elements['online-mode'] = element({ options: modeOptions, value: '0' });
const mapChoiceInputs = mapOptions.map(option => element({
  checked: false,
  name: 'halo-map-choice',
  value: option.value,
}));
const modeChoiceInputs = modeOptions.map(option => element({
  checked: false,
  name: 'halo-mode-choice',
  value: option.value,
}));
elements['online-map-options'].querySelectorAll = selector =>
  selector === 'input[name="halo-map-choice"]' ? mapChoiceInputs : [];
elements['online-mode-options'].querySelectorAll = selector =>
  selector === 'input[name="halo-mode-choice"]' ? modeChoiceInputs : [];
elements['online-invite'].hidden = true;
elements['online-progress'].hidden = true;
elements['online-step-mode'].hidden = true;
elements['online-join-confirm'].hidden = true;

const storage = new Map([
  ['halo.web.host-settings.v1', JSON.stringify({ mapIndex: 9, modeIndex: 2 })],
  ['halo.web.player-profile.v1', JSON.stringify({ name: 'TestSpartan', style: 'rose' })],
]);
const configuredHosts = [];
const advancedHosts = [];
const customizations = [];
const legacyCommands = [];
const socketMessages = [];
const intervals = new Map();
let nextTimer = 1;
let gameState = 2;
let fetchCount = 0;
let latestSocket = null;
let copyCommandSucceeds = true;

class FakeWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    latestSocket = this;
    queueMicrotask(() => this.onopen && this.onopen());
  }

  close() { this.readyState = 3; }
  send(value) { socketMessages.push(JSON.parse(value)); }
}

const context = {
  console,
  document: {
    readyState: 'complete',
    getElementById: id => elements[id],
    querySelector: selector => selector === 'meta[name="halo-build-id"]' ?
      { content: 'test-build' } :
      selector === 'meta[name="halo-signaling-url"]' ?
        { content: 'https://signal.example' } : null,
    execCommand: () => copyCommandSucceeds,
  },
  fetch: async () => {
    fetchCount++;
    return {
      ok: true,
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
    _platform_web_online_get_state: () => gameState,
    _platform_web_online_host_configured: (mapIndex, modeIndex) => {
      configuredHosts.push([mapIndex, modeIndex]);
      return 1;
    },
    _platform_web_online_host_advanced_configured: (...values) => {
      advancedHosts.push(values);
      return 1;
    },
    _platform_web_online_request: command => {
      legacyCommands.push(command);
      return 1;
    },
    _platform_web_online_set_player_customization: (...values) => {
      customizations.push(values);
      return 1;
    },
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

(async () => {
  assert.equal(elements['online-map'].value, '9');
  assert.equal(elements['online-mode'].value, '2');
  assert.equal(mapChoiceInputs.find(input => input.value === '9').checked, true);
  assert.equal(mapChoiceInputs.find(input => input.value === '9')['aria-checked'], 'true');
  assert.equal(modeChoiceInputs.find(input => input.value === '2').checked, true);
  assert.equal(modeChoiceInputs.find(input => input.value === '2')['aria-checked'], 'true');
  assert.equal(elements['online-player-name'].value, 'TestSpartan');
  assert.equal(styleInputs.find(input => input.checked).value, 'rose');
  assert.equal(elements['online-profile-preview-name'].textContent, 'TestSpartan');
  assert.equal(elements['online-profile-preview'].dataset.style, 'rose');
  assert.equal(elements['online-host'].disabled, true);
  assert.equal(elements['player-sidebar'].hidden, false);
  assert.equal(elements['player-count'].textContent, '0/128');
  assert.equal(elements['player-count']['aria-label'], 'Players in room: 0 of 128');

  elements['online-code'].value = 'room.1234567890abcdef';
  elements['online-join-form'].listeners.submit({ preventDefault() {} });
  assert.equal(elements['online-dialog'].open, true);
  assert.equal(elements['online-dialog'].dataset.view, 'join');
  assert.equal(elements['online-join-confirm'].hidden, false);
  assert.equal(elements['online-join-status'].hidden, false);
  assert.equal(elements['online-join-status'].textContent, 'Loading game…');
  await context.HaloOnline.leave();
  assert.equal(elements['online-dialog'].dataset.view, 'setup');

  context.HaloOnline.runtimeReady();
  assert.equal(elements['online-host'].disabled, false);

  elements.online.listeners.click();
  assert.equal(elements['online-dialog'].open, true);
  assert.equal(elements['online-dialog'].dataset.view, 'setup');

  const prisonerChoice = mapChoiceInputs.find(input => input.value === '4');
  elements['online-map-options'].listeners.change({ target: prisonerChoice });
  assert.equal(elements['online-map'].value, '4');
  assert.equal(prisonerChoice.checked, true);
  assert.equal(mapChoiceInputs.find(input => input.value === '9').checked, false);

  const raceChoice = modeChoiceInputs.find(input => input.value === '5');
  elements['online-mode-options'].listeners.change({ target: raceChoice });
  assert.equal(elements['online-mode'].value, '5');
  assert.equal(raceChoice.checked, true);
  assert.equal(modeChoiceInputs.find(input => input.value === '2').checked, false);

  /* Keep the remainder of this test focused on the stored Blood Gulch CTF setup. */
  elements['online-map'].value = '9';
  elements['online-map'].listeners.change();
  elements['online-mode'].value = '2';
  elements['online-mode'].listeners.change();

  for (const type of ['keydown', 'keyup', 'keypress']) {
    for (const target of ['online-dialog', 'player-sidebar']) {
      let propagationStopped = false;
      let defaultPrevented = false;
      elements[target].listeners[type]({
        preventDefault() { defaultPrevented = true; },
        stopPropagation() { propagationStopped = true; },
      });
      assert.equal(propagationStopped, true,
        `${type} from #${target} must not reach Halo`);
      assert.equal(defaultPrevented, false,
        `${type} must retain normal text and control behavior`);
    }
  }

  await assert.rejects(
    context.HaloOnline.host({ mapIndex: 13, modeIndex: 0 }),
    /valid map/);
  assert.equal(fetchCount, 0);

  elements['online-map-next'].listeners.click();
  assert.equal(elements['online-step-map'].hidden, true);
  assert.equal(elements['online-step-mode'].hidden, false);
  elements['online-mode-back'].listeners.click();
  assert.equal(elements['online-step-map'].hidden, false);
  assert.equal(elements['online-step-mode'].hidden, true);
  elements['online-map-next'].listeners.click();

  await context.HaloOnline.host();
  assert.deepEqual(configuredHosts, [[9, 2]]);
  assert.deepEqual(advancedHosts, []);
  assert.deepEqual(legacyCommands, []);
  assert.deepEqual(JSON.parse(storage.get('halo.web.host-settings.v1')),
    { mapIndex: 9, modeIndex: 2 });
  assert.deepEqual(JSON.parse(storage.get('halo.web.player-profile.v1')),
    { name: 'TestSpartan', style: 'rose' });
  assert.deepEqual(customizations, [[
    17,
    ...Array.from('TestSpartan', character => character.charCodeAt(0)),
  ]]);
  assert(socketMessages.some(message => message.type === 'profile' &&
    message.profile.name === 'TestSpartan' && message.profile.style === 'rose'));
  assert.equal(elements['online-invite'].hidden, false);
  assert.equal(elements['online-progress'].hidden, true);
  assert.equal(elements['online-dialog'].open, false,
    'the completed two-step wizard closes once the invite is available');
  assert.equal(elements['online-dialog'].dataset.view, 'progress');
  assert.equal(elements['player-count'].textContent, '1/128');
  assert.equal(elements['player-count']['aria-label'], 'Players in room: 1 of 128');
  assert.match(elements['invite-link'].value,
    /^https:\/\/halo\.example\/halo\.html#join=room\.1234567890abcdef$/);

  elements['invite-copy'].listeners.click();
  await Promise.resolve();
  assert.equal(elements['invite-copy'].textContent, 'Copied!');
  assert.equal(elements['invite-copy-status'].hidden, true);
  copyCommandSucceeds = false;
  elements['invite-copy'].textContent = 'Copy link';
  elements['invite-copy'].listeners.click();
  await Promise.resolve();
  assert.equal(elements['invite-copy'].textContent, 'Copy link');
  assert.equal(elements['invite-copy-status'].hidden, false);
  assert.match(elements['invite-copy-status'].textContent, /press .*Ctrl\+C/);

  latestSocket.onmessage({
    data: JSON.stringify({
      v: 1,
      type: 'roster',
      players: [
        {
          peerId: 'h_0123456789abcdef',
          role: 'host',
          profile: { name: 'TestSpartan', style: 'rose' },
        },
        {
          peerId: 'g_fedcba9876543210',
          role: 'guest',
          profile: { name: 'Friend', style: 'pink' },
        },
      ],
    }),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(elements['player-count'].textContent, '2/128');
  assert.equal(elements['player-count']['aria-label'], 'Players in room: 2 of 128');

  gameState = 3;
  const gamePoll = Array.from(intervals.values()).find(
    timer => timer.milliseconds === 200);
  assert(gamePoll, 'game-state polling was not started');
  gamePoll.callback();
  assert.equal(elements['online-invite'].hidden, false);
  assert.equal(elements['online-progress'].hidden, true);
  assert.equal(elements['online-dialog'].open, false);
  assert.match(elements['online-status'].textContent,
    /Blood Gulch · Capture the Flag is ready/);

  elements['invite-link'].focused = false;
  elements.online.listeners.click();
  assert.equal(elements['online-dialog'].open, false,
    'the sidebar button must not reopen a completed host wizard');
  assert.equal(elements['invite-link'].focused, true,
    'the sidebar button focuses the persistent sidebar invite');

  await context.HaloOnline.leave();
  assert.equal(elements['player-sidebar'].hidden, false);
  assert.equal(elements['player-sidebar'].dataset.onlineActive, 'false');
  assert.equal(elements['player-count'].textContent, '0/128');

  await context.HaloOnline.host({
    mapIndex: 4,
    modeIndex: 0,
    advanced: {
      scoreToWin: 25,
      respawnSeconds: 3,
      lives: 5,
      healthPercent: 150,
      infiniteGrenades: true,
      shields: false,
      invisiblePlayers: true,
      otherPlayersOnRadar: false,
    },
  });
  assert.deepEqual(configuredHosts, [[9, 2]],
    'advanced hosting must not pass through the stock host ABI');
  assert.deepEqual(advancedHosts, [[4, 0, 25, 3, 5, 150, 5]]);
  assert.deepEqual(JSON.parse(storage.get('halo.web.host-settings.v1')), {
    mapIndex: 4,
    modeIndex: 0,
    advanced: {
      scoreToWin: 25,
      respawnSeconds: 3,
      lives: 5,
      healthPercent: 150,
      infiniteGrenades: true,
      shields: false,
      invisiblePlayers: true,
      otherPlayersOnRadar: false,
    },
  });
  await context.HaloOnline.leave();

  console.log('online_client host setup tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
