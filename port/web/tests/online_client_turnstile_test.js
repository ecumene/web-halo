'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
assert.match(shell, /id="online-human-verification"[\s\S]*id="online-verification-status"[\s\S]*id="online-verification-retry"/);

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
    focus() {},
    removeAttribute(name) { delete this[name]; },
    replaceChildren() {},
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
  'online-map', 'online-mode', 'online-map-options', 'online-mode-options',
  'online-join-form', 'online-code', 'online-join', 'online-invite',
  'invite-link', 'invite-copy', 'invite-copy-status', 'online-leave-host',
  'online-progress', 'online-cancel', 'online-detail', 'canvas',
  'online-wizard', 'online-wizard-steps', 'online-wizard-map', 'online-wizard-mode',
  'online-step-map', 'online-step-mode', 'online-map-next', 'online-mode-back',
  'online-profile', 'online-player-name', 'online-style-options',
  'online-profile-preview', 'online-profile-preview-name', 'online-spartan-image',
  'online-join-confirm', 'online-join-profile', 'online-join-summary',
  'online-join-status', 'online-human-verification', 'online-verification-status',
  'online-verification-retry', 'online-turnstile', 'player-sidebar',
  'player-count', 'player-empty', 'player-sidebar-toggle',
].forEach(id => { elements[id] = element(); });

elements['online-map'].options = [{ value: '0', textContent: 'Battle Creek' }];
elements['online-map'].value = '0';
elements['online-mode'].options = [{ value: '0', textContent: 'Slayer' }];
elements['online-mode'].value = '0';
elements['online-map-options'].querySelectorAll = () => [];
elements['online-mode-options'].querySelectorAll = () => [];
const styleInput = element({ checked: true, value: 'sage' });
elements['online-style-options'].querySelectorAll = () => [styleInput];
elements['online-player-name'].value = 'Verifier';
elements['online-step-mode'].hidden = true;
elements['online-join-confirm'].hidden = true;
elements['online-invite'].hidden = true;
elements['online-progress'].hidden = true;

const renderCalls = [];
const removedWidgets = [];
const resetWidgets = [];
let nextWidgetId = 1;
const requestBodies = [];
const nativeInvite = 'halo://join/' + '8f60f64f5fb2cda7043454e4aecd305d' +
  '07153f6367a2d644d0737f1a46565982';

const context = {
  console,
  crypto: { getRandomValues(values) { values[0] = 7; return values; } },
  document: {
    readyState: 'complete',
    getElementById: id => elements[id],
    querySelector(selector) {
      if (selector === 'meta[name="halo-build-id"]') return { content: 'test-build' };
      if (selector === 'meta[name="halo-signaling-url"]') return { content: 'https://signal.example' };
      if (selector === 'meta[name="halo-turnstile-sitekey"]') {
        return { content: '0x4AAAAAAFJKYJ-u47UliqDs' };
      }
      return null;
    },
  },
  fetch: async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return {
      ok: false,
      status: 403,
      async json() {
        return {
          error: {
            code: 'TURNSTILE_REJECTED',
            message: 'Complete the human verification and try again.',
          },
        };
      },
    };
  },
  HaloWebTransport: {
    disconnectAll() {},
    getLocalIdentifier: () => '020000000001',
    isSupported: () => true,
  },
  history: { replaceState() {} },
  localStorage: {
    getItem() { return null; },
    setItem() {},
  },
  location: {
    hash: '#join=' + encodeURIComponent(nativeInvite),
    hostname: 'halo.example',
    href: 'https://halo.example/halo.html#join=' + encodeURIComponent(nativeInvite),
    origin: 'https://halo.example',
    pathname: '/halo.html',
    port: '',
    protocol: 'https:',
    search: '',
  },
  Module: {
    _platform_web_online_get_error: () => 0,
    _platform_web_online_get_state: () => 0,
    _platform_web_online_request: () => 1,
    _platform_web_online_set_transport_state() {},
  },
  navigator: {},
  turnstile: {
    remove(widgetId) { removedWidgets.push(widgetId); },
    render(_target, options) {
      renderCalls.push(options);
      return nextWidgetId++;
    },
    reset(widgetId) { resetWidgets.push(widgetId); },
  },
  URL,
  URLSearchParams,
  WebSocket: { OPEN: 1 },
  clearInterval() {},
  clearTimeout() {},
  setInterval: () => 1,
  setTimeout: () => 1,
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8'),
  context,
  { filename: 'online_client.js' });

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

(async () => {
  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].action, 'join_room');
  assert.equal(elements['online-dialog'].dataset.view, 'join');
  assert.equal(elements['online-join-profile'].disabled, false,
    'Join remains actionable while Turnstile and Halo finish');
  assert.equal(elements['online-human-verification'].dataset.state, 'loading');
  assert.match(elements['online-verification-status'].textContent, /Checking/);

  elements['online-join-profile'].listeners.click();
  assert.equal(requestBodies.length, 0,
    'an early click queues the join without bypassing verification');
  assert.match(elements['online-join-status'].textContent, /automatically/);

  renderCalls[0].callback('first-token');
  assert.equal(elements['online-human-verification'].dataset.state, 'ready');
  assert.match(elements['online-verification-status'].textContent, /Halo is still loading/);
  assert.equal(elements['online-join-profile'].disabled, false);
  assert.equal(requestBodies.length, 0,
    'a verified token still waits for the runtime');

  context.HaloOnline.runtimeReady();
  await settle();
  assert.equal(requestBodies.length, 1);
  assert.equal(requestBodies[0].turnstileToken, 'first-token');
  assert.equal(requestBodies[0].invite, nativeInvite);
  assert.equal(elements['online-dialog'].dataset.view, 'join',
    'a rejected token keeps the invite ready for another attempt');
  assert.equal(elements['online-human-verification'].dataset.state, 'error');
  assert.equal(elements['online-verification-retry'].hidden, false);
  assert.equal(elements['online-join-profile'].disabled, false,
    'a verification error must leave the manual retry path clickable');
  assert.match(elements['online-verification-status'].textContent, /won't need to refresh/);

  elements['online-verification-retry'].listeners.click();
  assert.equal(renderCalls.length, 2);
  assert.deepEqual(removedWidgets, [1]);
  assert.equal(elements['online-human-verification'].dataset.state, 'loading');
  assert.equal(elements['online-verification-retry'].hidden, true);

  renderCalls[0].callback('stale-token');
  assert.equal(elements['online-human-verification'].dataset.state, 'loading',
    'callbacks from removed widgets cannot satisfy verification');
  renderCalls[1].callback('retry-token');
  assert.equal(elements['online-join-profile'].disabled, false);
  assert.match(elements['online-verification-status'].textContent, /Verified/);
  assert(resetWidgets.length >= 1, 'used tokens are reset after submission');

  console.log('online client Turnstile lifecycle tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
