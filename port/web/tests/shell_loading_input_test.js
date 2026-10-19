'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const xinput = fs.readFileSync(
  path.join(webDirectory, '..', 'linux', 'src', 'xinput_sdl.c'), 'utf8');
const dsound = fs.readFileSync(
  path.join(webDirectory, '..', 'linux', 'src', 'dsound_sdl.c'), 'utf8');
const repository = path.join(webDirectory, '..', '..');
const terminal = fs.readFileSync(
  path.join(repository, 'source', 'interface', 'terminal.c'), 'utf8');
const webPlatform = fs.readFileSync(
  path.join(webDirectory, 'src', 'web_platform.c'), 'utf8');
const webOnlineUi = fs.readFileSync(
  path.join(webDirectory, 'src', 'web_online_ui.c'), 'utf8');
const worker = fs.readFileSync(
  path.join(repository, 'services', 'web', 'src', 'index.js'), 'utf8');
const wrangler = fs.readFileSync(
  path.join(repository, 'services', 'web', 'wrangler.jsonc'), 'utf8');
const stageCloudflare = fs.readFileSync(
  path.join(repository, 'tools', 'web_stage_cloudflare.py'), 'utf8');

const loading = shell.match(/<section id="loading"[\s\S]*?<\/section>/);
assert(loading, 'missing loading overlay');
assert.doesNotMatch(loading[0], /class="loading-wordmark"/,
  'loading must not show a large duplicate Halo wordmark');
assert.match(loading[0], /class="loading-mark"/);
assert.match(shell, /.loading-panel \{[\s\S]*?height: 5.25rem;/,
  'loading panel needs fixed geometry so status changes cannot move it');
assert.match(shell, /#loading progress\[hidden\][\s\S]*?visibility: hidden;/,
  'hidden progress must retain its reserved layout slot');
assert.doesNotMatch(shell, /url\("assets\/ui\/shell\/halo-ce-ring-menu\.jpg"\)/,
  'the launcher must not use the former game background');
assert.doesNotMatch(shell, /hud-frame\.png/,
  'the decorative blue HUD frame must not cover the game on constrained devices');

const setStatus = shell.match(/function setStatus\(text\) \{[\s\S]*?\n    \}/);
assert(setStatus, 'missing setStatus');
assert.doesNotMatch(setStatus[0], /loadingElement\.hidden = true/,
  'runtime status alone must never expose an unpresented black canvas');

const presentationGate = shell.match(
  /function waitForPresentedGame\(\) \{[\s\S]*?\n    \}/);
assert(presentationGate, 'missing first-presentation gate');
assert.match(presentationGate[0], /_platform_web_profile_loops/);
assert.match(presentationGate[0], /_platform_web_profile_swaps/);
assert.match(presentationGate[0], /!haloRuntimeReady/,
  'the presentation gate must not call WebAssembly exports before runtime initialization');
assert.match(presentationGate[0], /completedLoops >= 4/);
assert.match(presentationGate[0], /submittedFrames >= 2/);
assert.match(shell, /function revealPresentedGame\(token\)[\s\S]*token !== presentationWaitToken/);

const controls = shell.match(/<div class="game-controls"[\s\S]*?<\/div>/);
assert(controls, 'missing game controls');
assert.match(controls[0], /id="focus"/,
  'Focus game must be a visible control next to mute/fullscreen');
assert.match(controls[0], /id="game-settings-menu"[\s\S]*id="disable-player-magnetism"/,
  'the below-game settings menu must expose the aim-magnetism switch');
assert.doesNotMatch(controls[0], /id="focus"[^>]* hidden/);
assert.match(shell,
  /<section id="game-frame"[\s\S]*?<canvas[\s\S]*?<footer>[\s\S]*?<div class="game-controls"/,
  'game controls must render directly beneath the framed canvas');
assert.match(shell,
  /<div class="game-controls"[\s\S]*?id="footer-hint"/,
  'mouse-capture guidance must sit opposite the controls beneath the game');
assert.match(shell, /<header hidden>/,
  'the redundant top-right runtime chip must stay hidden');
assert.match(shell, /#game-frame footer \{[\s\S]*?background: transparent;/,
  'the controls must not render inside a full-width bottom bar');
assert.match(shell, /#game-area:fullscreen #game-frame footer \{\s*display: none;/,
  'fullscreen must hide the under-screen control row');
assert.doesNotMatch(shell, /main::after \{[\s\S]*?hud-frame\.png/,
  'the decorative website HUD overlay must be removed in every display mode');
const readyCanvasStyle = shell.match(/#game-frame canvas\.emscripten\.ready \{[\s\S]*?\n    \}/);
assert(readyCanvasStyle, 'missing ready game canvas styling');
assert.doesNotMatch(readyCanvasStyle[0], /border:|box-shadow:|clip-path:/,
  'the game canvas must not carry a decorative blue sci-fi frame');
assert.match(shell,
  /#game-area:fullscreen #player-sidebar,\s*#game-area:fullscreen #duke-legend \{ display: none; \}/,
  'fullscreen must hide the online sidebar and Duke legend');
assert.match(shell, /id="duke-legend"[\s\S]*<svg class="keyboard-diagram"/,
  'the legend must use the original keyboard diagram');
assert.match(shell, /<dt>A<\/dt>[\s\S]*?<dd>- Space<\/dd>[\s\S]*?<dt>B<\/dt>[\s\S]*?<dd>- F<\/dd>[\s\S]*?<dt>X<\/dt><dd>- E \/ R<\/dd>[\s\S]*?<dt>Y<\/dt><dd>- Tab \/ Wheel<\/dd>[\s\S]*?<dt>White<\/dt><dd>- Q<\/dd>[\s\S]*?<dt>Black<\/dt><dd>- X<\/dd>[\s\S]*?<dt>LT<\/dt><dd>- G \/ RMB<\/dd>[\s\S]*?<dt>RT<\/dt><dd>- LMB<\/dd>[\s\S]*?<dt>Move<\/dt><dd>- WASD<\/dd>[\s\S]*?<dt>Aim<\/dt><dd>- Mouse<\/dd>[\s\S]*?<dt>L3<\/dt><dd>- C<\/dd>[\s\S]*?<dt>R3<\/dt><dd>- Z \/ MMB<\/dd>[\s\S]*?<dt>D-pad<\/dt><dd>- Arrows<\/dd>[\s\S]*?<dt>Start<\/dt><dd>- Esc<\/dd>[\s\S]*?<dt>Back<\/dt><dd>- F1<\/dd>/,
  'the high-resolution Duke legend must document the complete keyboard mapping');
assert.doesNotMatch(shell, /<figcaption>Duke<\/figcaption>/,
  'the controller image must not carry a redundant Duke caption');
assert.match(shell, /Made by[\s\S]*mitchellhynes\.com[\s\S]*Mitchell Hynes[\s\S]*id="about-open"[\s\S]*Learn more/,
  'the under-screen row must include the compact creator credit');
assert.match(shell, /id="about-dialog"[\s\S]*<svg class="lab-mark"[\s\S]*github\.com\/bnunu\/halo-ce-universal[\s\S]*github\.com\/cybersecurity\/halo-ce-universal[\s\S]*independently hosted[\s\S]*mitchellhynes\.com[\s\S]*responsible for this website/,
  'Learn more must disclose sources and independence alongside the original site mark');
assert.doesNotMatch(shell, /ko-fi|kofi-support|Buy me a coffee/i,
  'the site must not include Ko-fi links or promotional copy');
assert.match(shell, /onlineDialog\.open \|\| aboutDialog\.open/,
  'the creator dialog must own keyboard focus instead of controlling Halo');
assert.match(shell, /addEventListener\("pointerlockchange"/);
assert.match(shell, /addEventListener\("pointerlockerror"/);

const tabBranch = shell.match(
  /if \(event\.key === "Tab"[\s\S]*?\} else if/);
assert(tabBranch, 'missing in-game Tab handling');
assert.match(tabBranch[0], /event\.preventDefault\(\)/,
  'Tab must suppress browser focus traversal while Halo owns input');
assert.doesNotMatch(tabBranch[0], /stopPropagation/,
  'Tab must continue propagating to SDL so it can switch weapons');
assert.match(shell, /!diagnosticsOverlay\.hidden \|\| onlineDialog\.open/,
  'web dialogs must retain accessible Tab navigation');
assert.match(shell,
  /platform_web_set_player_magnetism_enabled[\s\S]*enabled \? 1 : 0/,
  'the game setting must change Halo player_magnetism_flag through a native export');
assert.match(shell,
  /playerMagnetismManual = false[\s\S]*playerInputMode = "keyboard-mouse"[\s\S]*disablePlayerMagnetism\.checked = playerMagnetismManual \?[\s\S]*: true/,
  'keyboard and mouse must default to disabled magnetism unless a manual preference exists');
assert.match(shell,
  /function setAutomaticInputMode\(mode\)[\s\S]*playerMagnetismManual \|\| mode === playerInputMode[\s\S]*mode !== "controller"[\s\S]*applyPlayerMagnetism\(\)/,
  'automatic input switching must enable magnetism for controllers without overriding manual choices');
assert.match(shell,
  /Array\.from\(gamepad\.buttons \|\| \[\]\)\.some[\s\S]*Array\.from\(gamepad\.axes \|\| \[\]\)\.some[\s\S]*setAutomaticInputMode\("controller"\)/,
  'real gamepad activity must select the controller magnetism default');
assert.match(shell,
  /\.control-button:hover,[\s\S]*?\.control-button:active,[\s\S]*?\.game-settings-menu\[open\] > summary[\s\S]*?background: rgba\(238, 143, 76, \.32\)/,
  'game controls must share the same hover, pressed, and open visual state');
assert.match(shell,
  /canvas\.addEventListener\("pointerdown"[\s\S]*setAutomaticInputMode\("keyboard-mouse"\)[\s\S]*document\.addEventListener\("keydown"[\s\S]*setAutomaticInputMode\("keyboard-mouse"\)/,
  'keyboard and mouse activity must restore the non-magnetized automatic default');
assert.match(shell,
  /document\.addEventListener\("pointerdown"[\s\S]*?gameSettingsMenu\.open[\s\S]*?!gameSettingsMenu\.contains\(event\.target\)[\s\S]*?removeAttribute\("open"\)/,
  'clicking outside the game-settings popover must dismiss it');

const connectedGamepads = xinput.match(
  /static DWORD connected_gamepads\(void\)[\s\S]*?\n\}/);
assert(connectedGamepads, 'missing connected_gamepads');
assert.match(connectedGamepads[0], /first pad shares port 0 with the keyboard/);
assert.doesNotMatch(connectedGamepads[0], /HALO_WEB/,
  'web must not shift the first physical controller away from player one');
assert.match(xinput,
  /if \(count > 0\)\s+sdl_gamepad_state\(gamepads\[0\], &state->Gamepad\);/,
  'the first physical controller must merge into Halo player one');
assert.match(xinput,
  /#ifdef HALO_WEB[\s\S]*?if \(k\[SDL_SCANCODE_C\]\) pad->wButtons \|= XINPUT_GAMEPAD_LEFT_THUMB;[\s\S]*?#else[\s\S]*?SDL_SCANCODE_LCTRL/,
  'web crouch must use C without exposing Ctrl movement shortcuts');
assert.match(shell,
  /function lockFullscreenMovementKeys\(\)[\s\S]*?navigator\.keyboard\.lock\(\["KeyW", "KeyA", "KeyS", "KeyD"\]\)[\s\S]*?fullscreenchange[\s\S]*?lockFullscreenMovementKeys\(\)/,
  'fullscreen should progressively lock movement keys against browser shortcuts');
assert.match(shell,
  /function connectedGamepads\(\)[\s\S]*?try[\s\S]*?navigator\.getGamepads\(\) \|\| \[\][\s\S]*?catch[\s\S]*?function refreshControllerStatus\(\)[\s\S]*?Player 1[\s\S]*?controllers detected/,
  'controller discovery must be guarded and continuously report connected controllers');
assert.match(shell,
  /gamepadconnected", event => \{[\s\S]*?setAutomaticInputMode\("controller"\)[\s\S]*?refreshControllerStatus\(event\)[\s\S]*?gamepaddisconnected", refreshControllerStatus/,
  'controller status must update for hot-plug and disconnect events');
assert.match(shell,
  /controllerSummary[\s\S]*?mouse capture optional/,
  'a controller must remain usable without mouse capture');
assert.match(dsound,
  /#ifndef HALO_WEB\s*SDL_SetHint\(SDL_HINT_AUDIO_DEVICE_SAMPLE_FRAMES, "512"\);\s*#endif/,
  'web audio must keep SDL Emscripten\'s larger browser-safe default buffer');
assert.match(dsound,
  /web_audio_record_callback[\s\S]*?platform_web_audio_callback_count[\s\S]*?platform_web_audio_late_callback_count[\s\S]*?platform_web_audio_maximum_callback_gap_ms/,
  'web audio must expose callback-gap telemetry for diagnosing underruns');
assert.match(shell,
  /function browserAudioContext\(\)[\s\S]*?Module\.SDL3[\s\S]*?function resumeBrowserAudio\(\)[\s\S]*?context\.resume\(\)/,
  'the mute control must resume SDL WebAudio from a trusted user gesture');
assert.match(shell,
  /muteButton\.addEventListener\("click"[\s\S]*?resumeBrowserAudio\(\)/,
  'unmuting must explicitly wake the browser audio context');
assert.match(shell,
  /audioCallbacks:[\s\S]*?audioLateCallbacks:[\s\S]*?audioMaximumGapMs:/,
  'performance summaries must include audio underrun counters');
assert.match(worker,
  /audio_running[\s\S]*?audio_suspended[\s\S]*?audio_blocked[\s\S]*?audioMaximumGapMs/,
  'the Worker must accept audio state and underrun telemetry');
assert.match(terminal, /terminal_render_enable \|\| terminal_globals\.input_state/,
  'backquote console output must be visible while its input is active');
assert.match(webPlatform, /platform_web_map_load_progress/);
assert.match(webPlatform, /platform_web_map_load_index/);
assert.match(webPlatform,
  /platform_web_campaign_active[\s\S]*?main_campaign_in_progress/,
  'campaign presence must come from the running game rather than a browser guess');
assert.match(webOnlineUi, /platform_web_online_get_client_state/);
assert.match(shell,
  /id="live-player-online"[\s\S]*?players online[\s\S]*?id="live-player-campaign"[\s\S]*?players in campaign[\s\S]*?id="live-player-today"[\s\S]*?players today/,
  'the subtle sidebar presence line must show online, campaign, and daily counts');
assert.match(shell,
  /function sendRuntimeTelemetry\([\s\S]*?\/v1\/telemetry\/runtime[\s\S]*?function updateRuntimeTelemetry\([\s\S]*?map_load_stalled/,
  'startup, online and map-load milestones must reach runtime telemetry');
assert.match(shell,
  /let haloRuntimeReady = false;[\s\S]*?function moduleMetric\([\s\S]*?if \(!haloRuntimeReady\) return fallback;[\s\S]*?onRuntimeInitialized\(\) \{\s*haloRuntimeReady = true;/,
  'slow hosts must not call native telemetry exports before WebAssembly initialization');
assert.match(worker, /RUNTIME_ROUTE = "\/v1\/telemetry\/runtime"[\s\S]*?RUNTIME_TELEMETRY/,
  'the Worker must accept runtime telemetry');
assert.match(wrangler, /"binding": "RUNTIME_TELEMETRY"[\s\S]*?"dataset": "halo_web_runtime"/,
  'runtime telemetry needs an Analytics Engine binding');
assert.match(shell,
  /function sendRuntimeFailure\([\s\S]*?runtimeFirstFailureSent[\s\S]*?errorFingerprint[\s\S]*?errorTopFrame/,
  'runtime failures must be deduplicated and fingerprinted before upload');
assert.match(shell,
  /errorCategory:[\s\S]*?visibility:[\s\S]*?isolation:[\s\S]*?sharedMemory:[\s\S]*?webgl:[\s\S]*?gamepadApi:[\s\S]*?hardwareConcurrency:[\s\S]*?deviceMemoryGb:/,
  'runtime telemetry must include privacy-safe capability context');
assert.doesNotMatch(shell,
  /errorMessage:\s*|errorStack:\s*/,
  'runtime telemetry must never upload raw messages or stack traces');
assert.match(worker,
  /env\.RUNTIME_TELEMETRY\.writeDataPoint\([\s\S]*?errorCategory,[\s\S]*?errorFingerprint,[\s\S]*?errorTopFrame,[\s\S]*?hardwareConcurrency, deviceMemoryGb/,
  'the Worker must persist crash fingerprints and capability context');
assert.match(stageCloudflare,
  /asset_build_id[\s\S]*?sha256[\s\S]*?stamp_build_id[\s\S]*?halo-build-id/,
  'staged deployments must carry a content-addressed build ID');
assert.match(webPlatform,
  /new URL\("assets\/maps", scriptDirectory\)\.href/,
  'map downloads must resolve from the loaded script when hosted below /halo/');
assert.match(shell, /<script src="coi-serviceworker\.js"><\/script>/,
  'static hosting must bootstrap cross-origin isolation before Halo loads');
assert.match(stageCloudflare, /coi-serviceworker\.js/,
  'the staged browser build must include the isolation service worker');

const normalizerSource = shell.match(
  /function normalizeTelemetryError\(value\) \{[\s\S]*?\n    \}/);
assert(normalizerSource, 'missing telemetry error sanitizer');
const normalizeTelemetryError = Function(`return (${normalizerSource[0]});`)();
const normalizedFailure = normalizeTelemetryError(
  'TypeError at https://example.test/halo.js:1:93820 id 0123456789abcdef');
assert.doesNotMatch(normalizedFailure, /example\.test|93820|0123456789abcdef/,
  'error sanitizer must remove URLs, offsets and long identifiers');

const classifierSource = shell.match(
  /function classifyRuntimeError\(value\) \{[\s\S]*?\n    \}/);
assert(classifierSource, 'missing runtime error classifier');
const classifyRuntimeError = Function(
  `const normalizeTelemetryError = ${normalizerSource[0]}; return (${classifierSource[0]});`)();
assert.equal(classifyRuntimeError('RangeError: WebAssembly.Memory allocation failed'), 'wasm-memory');
assert.equal(classifyRuntimeError('navigator.getGamepads is not a function'), 'gamepad');
assert.equal(classifyRuntimeError('emscripten_proxy_async failed'), 'threading');

const rendererClassifier = shell.match(
  /function classifyRenderer\(value\) \{[\s\S]*?\n    \}/);
assert(rendererClassifier, 'missing normalized renderer classification');
const classifyRenderer = Function(`return (${rendererClassifier[0]});`)();
assert.equal(classifyRenderer('ANGLE (Google, Vulkan SwiftShader)'), 'software');
assert.equal(classifyRenderer('ANGLE Metal Renderer: Apple M3'), 'apple');
assert.match(shell, /Graphics acceleration appears to be off/,
  'software rendering needs an actionable loading hint');

const extensionGuard = shell.match(
  /function isBrowserExtensionFailure\(message, source\) \{[\s\S]*?\n    \}/);
assert(extensionGuard, 'missing browser-extension error guard');
const isBrowserExtensionFailure = Function(
  `return (${extensionGuard[0]});`)();
assert.equal(isBrowserExtensionFailure('Failed to connect to MetaMask', ''), true,
  'MetaMask injection failures must not replace the Halo loading screen');
assert.equal(isBrowserExtensionFailure(
  'Uncaught Error', 'chrome-extension://wallet/inpage.js:1:1'), true,
  'Chrome extension stacks must remain non-fatal');
assert.equal(isBrowserExtensionFailure(
  'Uncaught Error', 'moz-extension://wallet/inpage.js:1:1'), true,
  'Firefox extension stacks must remain non-fatal');
assert.equal(isBrowserExtensionFailure(
  'RuntimeError: unreachable', 'https://halo.example/halo.js:1:1'), false,
  'genuine Halo runtime failures must still reach the fatal error panel');
assert.match(shell,
  /addEventListener\("error"[\s\S]*?isBrowserExtensionFailure\(message, source\)[\s\S]*?ignored browser extension error[\s\S]*?return;[\s\S]*?setStatus\(`Could not start:/,
  'extension script errors must be ignored before setting fatal status');
assert.match(shell,
  /addEventListener\("unhandledrejection"[\s\S]*?isBrowserExtensionFailure\(message, source\)[\s\S]*?ignored browser extension rejection[\s\S]*?return;[\s\S]*?setStatus\(`Could not start:/,
  'extension promise rejections must be ignored before setting fatal status');

console.log('shell loading, focus, Tab, and controller routing tests passed');
