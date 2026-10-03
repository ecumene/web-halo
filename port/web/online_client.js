/* Private-room signalling and the browser "Play online" experience.

   Gameplay never passes through the room service.  It only exchanges room
   membership and WebRTC descriptions/candidates, then Halo's normal system-
   link packets travel through HaloWebTransport's DataChannels. */

;(function installHaloOnline(global) {
  "use strict";

  if (!global || global.HaloOnline) return;

  var PROTOCOL_VERSION = 1;
  var ROOM_CAPACITY = 128;
  var MAX_PENDING_SIGNALING_MESSAGES = ROOM_CAPACITY * 128;
  var HEARTBEAT_MILLISECONDS = 40000;
  var PRESENCE_POLL_MILLISECONDS = 30000;
  var GAME_POLL_MILLISECONDS = 200;
  var TURNSTILE_RENDER_ATTEMPTS = 80;
  var HOST_SETTINGS_STORAGE_KEY = "halo.web.host-settings.v1";
  var PLAYER_PROFILE_STORAGE_KEY = "halo.web.player-profile.v1";
  var PLAYER_NAME_MAXIMUM_LENGTH = 11;
  var LAST_MAP_INDEX = 12;
  var LAST_MODE_INDEX = 5;
  var ADVANCED_MODE_DEFAULTS = Object.freeze([
    { scoreToWin: 15, respawnSeconds: 0 },
    { scoreToWin: 50, respawnSeconds: 10 },
    { scoreToWin: 3, respawnSeconds: 10 },
    { scoreToWin: 2, respawnSeconds: 5 },
    { scoreToWin: 2, respawnSeconds: 5 },
    { scoreToWin: 3, respawnSeconds: 0 },
  ]);
  var PLAYER_STYLES = Object.freeze([
    "white", "black", "red", "blue", "sage", "yellow", "lime", "pink", "purple",
    "cyan", "cornflower", "orange", "teal", "forest", "brown", "tan", "maroon", "rose",
  ]);
  var PLAYER_STYLE_COLORS = Object.freeze({
    white: 0,
    black: 1,
    red: 2,
    blue: 3,
    sage: 4,
    yellow: 5,
    lime: 6,
    pink: 7,
    purple: 8,
    cyan: 9,
    cornflower: 10,
    orange: 11,
    teal: 12,
    forest: 13,
    brown: 14,
    tan: 15,
    maroon: 16,
    rose: 17,
  });

  var COMMAND = Object.freeze({ HOST: 1, JOIN: 2, CANCEL: 3 });
  var GAME_STATE = Object.freeze({
    IDLE: 0,
    WAITING: 1,
    HOST_STARTING: 2,
    HOSTING: 3,
    JOIN_SEARCHING: 4,
    JOIN_CONNECTING: 5,
    JOINED: 6,
    ERROR: 7,
  });
  var TRANSPORT_STATE = Object.freeze({
    DISCONNECTED: 0,
    CONNECTING: 1,
    CONNECTED: 2,
    FAILED: 3,
  });
  var GAME_ERRORS = Object.freeze({
    1: "Halo could not open the host lobby.",
    2: "Halo could not start its multiplayer client.",
    3: "Halo could not open the pregame lobby.",
    4: "The host rejected or ended the join.",
    5: "The host lobby did not answer within 90 seconds.",
  });

  var elements = {};
  var humanVerification = {
    action: null,
    busy: false,
    generation: 0,
    renderAttempts: 0,
    renderTimer: 0,
    state: "idle",
    token: null,
    widgetId: null,
  };
  var session = {
    runtimeReady: false,
    active: false,
    closing: false,
    role: null,
    room: null,
    roomTicket: null,
    inviteCode: null,
    inviteUrl: null,
    selfPeerId: null,
    iceServers: [],
    socket: null,
    socketGeneration: 0,
    operationGeneration: 0,
    heartbeatTimer: 0,
    reconnectTimer: 0,
    reconnectAttempts: 0,
    gamePollTimer: 0,
    gameCommandIssued: false,
    transportConnected: false,
    connectedPeerCount: 0,
    connectionPath: null,
    peerPromises: new Map(),
    peerIdentifiers: new Map(),
    peerStates: new Map(),
    peerAliases: new Map(),
    peerSignalTargets: new Map(),
    roster: new Map(),
    messageChain: Promise.resolve(),
    pendingInvite: null,
    profile: null,
    hostWasReady: false,
    hostSettings: null,
    guestWasJoined: false,
    leavePromise: null,
    joinRequested: false,
    wizardStep: "map",
    presenceTimer: 0,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function syncTelemetryContext() {
    if (!global.HaloTelemetry || typeof global.HaloTelemetry.setContext !== "function") return;
    global.HaloTelemetry.setContext({
      role: session.role === "host" ? "host" : (session.role === "guest" ? "guest" : "offline"),
      connection: session.connectionPath || "unknown",
    });
  }

  function telemetry(event, stage) {
    if (global.HaloTelemetry && typeof global.HaloTelemetry.event === "function") {
      global.HaloTelemetry.event(event, stage);
    }
  }

  function collectElements() {
    elements.button = byId("online");
    elements.dialog = byId("online-dialog");
    elements.close = byId("online-close");
    elements.status = byId("online-status");
    elements.description = byId("online-description");
    elements.setup = byId("online-setup");
    elements.hostForm = byId("online-host-form");
    elements.host = byId("online-host");
    elements.map = byId("online-map");
    elements.mode = byId("online-mode");
    elements.mapOptions = byId("online-map-options");
    elements.modeOptions = byId("online-mode-options");
    elements.advancedEnabled = byId("online-advanced-enabled");
    elements.advancedFields = byId("online-advanced-fields");
    elements.scoreToWin = byId("online-score-to-win");
    elements.respawnSeconds = byId("online-respawn-seconds");
    elements.lives = byId("online-lives");
    elements.healthPercent = byId("online-health-percent");
    elements.infiniteGrenades = byId("online-infinite-grenades");
    elements.shields = byId("online-shields");
    elements.invisiblePlayers = byId("online-invisible-players");
    elements.otherPlayersOnRadar = byId("online-other-players-on-radar");
    elements.joinForm = byId("online-join-form");
    elements.code = byId("online-code");
    elements.join = byId("online-join");
    elements.invite = byId("online-invite");
    elements.inviteLink = byId("invite-link");
    elements.copy = byId("invite-copy");
    elements.copyStatus = byId("invite-copy-status");
    elements.leaveHost = byId("online-leave-host");
    elements.progress = byId("online-progress");
    elements.cancel = byId("online-cancel");
    elements.detail = byId("online-detail");
    elements.wizard = byId("online-wizard");
    elements.wizardSteps = byId("online-wizard-steps");
    elements.wizardMap = byId("online-wizard-map");
    elements.wizardMode = byId("online-wizard-mode");
    elements.wizardLink = byId("online-wizard-link");
    elements.stepMap = byId("online-step-map");
    elements.stepMode = byId("online-step-mode");
    elements.stepLink = byId("online-step-link");
    elements.mapNext = byId("online-map-next");
    elements.modeBack = byId("online-mode-back");
    elements.profile = byId("online-profile");
    elements.playerName = byId("online-player-name");
    elements.styleOptions = byId("online-style-options");
    elements.profilePreview = byId("online-profile-preview");
    elements.profilePreviewName = byId("online-profile-preview-name");
    elements.spartanImage = byId("online-spartan-image");
    elements.joinConfirm = byId("online-join-confirm");
    elements.joinProfile = byId("online-join-profile");
    elements.joinSummary = byId("online-join-summary");
    elements.joinStatus = byId("online-join-status");
    elements.verification = byId("online-human-verification");
    elements.verificationStatus = byId("online-verification-status");
    elements.verificationRetry = byId("online-verification-retry");
    elements.turnstile = byId("online-turnstile");
    elements.playerSidebar = byId("player-sidebar");
    elements.playerList = byId("player-list");
    elements.playerCount = byId("player-count");
    elements.playerEmpty = byId("player-empty");
    elements.playerSidebarToggle = byId("player-sidebar-toggle");
    elements.livePlayerCount = byId("live-player-count");
    elements.livePlayerOnline = byId("live-player-online");
    elements.livePlayerCampaign = byId("live-player-campaign");
    elements.livePlayerToday = byId("live-player-today");
  }

  function playerCountLabel(count, suffix) {
    return count + (count === 1 ? " player " : " players ") + suffix;
  }

  async function refreshLivePlayerCount() {
    if (!elements.livePlayerCount || document.hidden) return;
    try {
      var snapshot = global.HaloTelemetry &&
        typeof global.HaloTelemetry.presence === "function"
        ? global.HaloTelemetry.presence() : null;
      var result = await fetchJson("/v1/presence", snapshot ? {
        body: JSON.stringify(snapshot),
        cache: "no-store",
        method: "POST",
      } : {
        cache: "no-store",
        headers: { Accept: "application/json" },
        method: "GET",
      });
      if (
        !Number.isInteger(result.online) || result.online < 0 ||
        !Number.isInteger(result.campaign) || result.campaign < 0 ||
        !Number.isInteger(result.today) || result.today < 0
      ) return;
      elements.livePlayerOnline.textContent = playerCountLabel(result.online, "online");
      elements.livePlayerCampaign.textContent = playerCountLabel(result.campaign, "in campaign");
      elements.livePlayerToday.textContent = playerCountLabel(result.today, "today");
      elements.livePlayerCount.setAttribute(
        "aria-label",
        playerCountLabel(result.online, "online") + ", " +
        playerCountLabel(result.campaign, "in campaign") + ", " +
        playerCountLabel(result.today, "today"),
      );
      elements.livePlayerCount.hidden = false;
    } catch (error) {
      /* Presence is decorative and must never interfere with the game. */
    }
  }

  function startPresencePolling() {
    if (!elements.livePlayerCount || !elements.livePlayerOnline ||
        !elements.livePlayerCampaign || !elements.livePlayerToday) return;
    refreshLivePlayerCount();
    if (session.presenceTimer) global.clearInterval(session.presenceTimer);
    session.presenceTimer = global.setInterval(
      refreshLivePlayerCount,
      PRESENCE_POLL_MILLISECONDS,
    );
    document.addEventListener("visibilitychange", function() {
      if (!document.hidden) refreshLivePlayerCount();
    });
  }

  function buildId() {
    var page = new URL(global.location.href);
    var meta = document.querySelector('meta[name="halo-build-id"]');
    var value = meta && meta.content;
    var pageIsLoopback = page.hostname === "127.0.0.1" || page.hostname === "localhost";
    /* A query override is useful while testing two local builds, but a public
       invite must not be able to opt an incompatible client into a room. */
    if (pageIsLoopback && page.searchParams.get("build")) {
      value = page.searchParams.get("build");
    }
    return value && /^[A-Za-z0-9._-]{1,96}$/.test(value) ? value : "development";
  }

  function apiBase() {
    var page = new URL(global.location.href);
    var query = page.searchParams.get("signal");
    var meta = document.querySelector('meta[name="halo-signaling-url"]');
    var pageIsLoopback = page.hostname === "127.0.0.1" || page.hostname === "localhost";
    if (query) {
      var override = new URL(query, global.location.href);
      var overrideIsLoopback = override.hostname === "127.0.0.1" ||
        override.hostname === "localhost";
      if (!pageIsLoopback || !overrideIsLoopback) {
        throw new Error("Custom room services are allowed only for loopback development.");
      }
    }
    var configured = query || (meta && meta.content);
    if (configured) {
      var parsed = new URL(configured, global.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("The room service URL must use HTTP or HTTPS.");
      }
      return parsed.href.replace(/\/$/, "");
    }
    if ((page.hostname === "127.0.0.1" || page.hostname === "localhost") &&
        page.port !== "8787") {
      return page.protocol + "//" + page.hostname + ":8787";
    }
    return page.origin;
  }

  function turnstileSiteKey() {
    var meta = document.querySelector('meta[name="halo-turnstile-sitekey"]');
    var value = meta && meta.content;
    return value && /^0x[A-Za-z0-9_-]{20,120}$/.test(value) ? value : null;
  }

  function clearTurnstileTimer() {
    if (humanVerification.renderTimer) global.clearTimeout(humanVerification.renderTimer);
    humanVerification.renderTimer = 0;
  }

  function turnstileReady(action) {
    return !turnstileSiteKey() ||
      (humanVerification.action === action && !!humanVerification.token);
  }

  function syncVerificationButtons() {
    if (elements.host) {
      elements.host.disabled = humanVerification.busy || !session.runtimeReady ||
        !turnstileReady("create_room");
    }
    if (elements.joinProfile) {
      elements.joinProfile.disabled = humanVerification.busy;
    }
  }

  function setVerificationState(state, message) {
    humanVerification.state = state;
    if (elements.verification) {
      elements.verification.hidden = !turnstileSiteKey();
      elements.verification.dataset.state = state;
    }
    if (elements.verificationStatus) {
      elements.verificationStatus.textContent = message || "";
      elements.verificationStatus.hidden = !message;
    }
    if (elements.verificationRetry) {
      elements.verificationRetry.hidden = state !== "error";
    }
    syncVerificationButtons();
  }

  function resetTurnstile() {
    humanVerification.token = null;
    if (turnstileSiteKey()) {
      setVerificationState("loading", "Checking that you're human…");
    }
    if (global.turnstile && humanVerification.widgetId !== null) {
      try { global.turnstile.reset(humanVerification.widgetId); } catch (error) { /* not rendered */ }
    }
  }

  function renderTurnstile(action, force) {
    var sitekey = turnstileSiteKey();
    if (!sitekey || !elements.turnstile) {
      setVerificationState("ready", "");
      return;
    }
    if (!force && humanVerification.action === action &&
        humanVerification.widgetId !== null) return;
    clearTurnstileTimer();
    var changedAction = humanVerification.action !== action;
    humanVerification.action = action;
    humanVerification.token = null;
    if (changedAction || force) {
      humanVerification.generation++;
      humanVerification.renderAttempts = 0;
      setVerificationState("loading", "Checking that you're human…");
    }
    if (!global.turnstile || typeof global.turnstile.render !== "function") {
      humanVerification.renderAttempts++;
      if (humanVerification.renderAttempts >= TURNSTILE_RENDER_ATTEMPTS) {
        setVerificationState(
          "error",
          "Human verification is taking longer than expected. Try it again.");
        return;
      }
      humanVerification.renderTimer = global.setTimeout(function() {
        renderTurnstile(action);
      }, 150);
      return;
    }
    if (humanVerification.widgetId !== null) {
      try { global.turnstile.remove(humanVerification.widgetId); } catch (error) { /* stale widget */ }
      humanVerification.widgetId = null;
    }
    elements.turnstile.replaceChildren();
    var generation = humanVerification.generation;
    try {
      humanVerification.widgetId = global.turnstile.render(elements.turnstile, {
        action: action,
        appearance: "interaction-only",
        callback: function(token) {
          if (generation !== humanVerification.generation || humanVerification.action !== action) return;
          humanVerification.token = token;
          setVerificationState(
            "ready",
            action === "join_room"
              ? (session.runtimeReady ? "Verified — ready to join." : "Verified — Halo is still loading.")
              : "Verified — ready to create your link.");
          if (action !== "join_room" || session.runtimeReady) setStatus("");
          maybeStartRequestedJoin();
        },
        "error-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState(
            "error",
            "We couldn't verify you this time. Check your connection and try again.");
        },
        "expired-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState("loading", "Verification expired — checking again…");
          try {
            global.turnstile.reset(humanVerification.widgetId);
          } catch (error) {
            setVerificationState("error", "Verification expired. Try it again.");
          }
        },
        "timeout-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState("error", "Human verification timed out. Try it again.");
        },
        sitekey: sitekey,
        size: "flexible",
        theme: "dark",
      });
    } catch (error) {
      humanVerification.widgetId = null;
      setVerificationState("error", "Human verification could not start. Try it again.");
    }
  }

  function consumeTurnstile(action) {
    if (!turnstileSiteKey()) return null;
    if (humanVerification.action !== action || !humanVerification.token) {
      renderTurnstile(action);
      throw new Error(humanVerification.state === "error" ?
        "Use Try again to restart human verification." :
        "One moment — human verification is still finishing.");
    }
    var token = humanVerification.token;
    humanVerification.token = null;
    return token;
  }

  function maybeStartRequestedJoin() {
    if (!session.joinRequested || humanVerification.busy) return;
    var invite = session.pendingInvite;
    if (!invite) {
      session.joinRequested = false;
      setStatus("That invite is no longer available.", "error");
      return;
    }
    if (!session.runtimeReady) {
      setStatus("Halo is still loading. Your game will join automatically when it is ready.");
      return;
    }
    if (!turnstileReady("join_room")) {
      setStatus("Finishing human verification…");
      renderTurnstile("join_room", humanVerification.state === "error");
      return;
    }
    try {
      readPlayerProfile();
      session.joinRequested = false;
      join(invite, consumeTurnstile("join_room")).catch(fail);
    } catch (error) {
      session.joinRequested = false;
      setStatus(error.message, "error");
    }
  }

  function requestJoinFromProfile() {
    session.joinRequested = true;
    maybeStartRequestedJoin();
  }

  function showDialog() {
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  /* SDL listens for keyboard events on window so the game keeps receiving
     input when its canvas has focus. Keyboard events from modal and sidebar
     controls bubble there too unless their surfaces contain them. Do not
     prevent the default: text editing, control activation, and Escape's
     native dialog behavior must keep working. */
  function containDialogKeyboardEvent(event) {
    event.stopPropagation();
  }

  function setHeader(text, state) {
    elements.button.textContent = text;
    elements.button.dataset.state = state || "offline";
  }

  function setStatus(text, tone) {
    var message = String(text || "").trim();
    elements.status.textContent = message;
    elements.status.hidden = !message;
    if (tone) elements.status.dataset.tone = tone;
    else delete elements.status.dataset.tone;
    if (elements.joinStatus) {
      var joinView = elements.dialog && elements.dialog.dataset.view === "join";
      elements.joinStatus.textContent = message;
      elements.joinStatus.hidden = !message || !joinView;
      if (tone) elements.joinStatus.dataset.tone = tone;
      else delete elements.joinStatus.dataset.tone;
    }
  }

  function setBusy(busy) {
    humanVerification.busy = !!busy;
    elements.map.disabled = !!busy;
    elements.mode.disabled = !!busy;
    setPickerLocked(elements.mapOptions, "halo-map-choice", !!busy);
    setPickerLocked(elements.modeOptions, "halo-mode-choice", !!busy);
    elements.join.disabled = !!busy || !session.runtimeReady;
    elements.code.disabled = !!busy;
    if (elements.mapNext) elements.mapNext.disabled = !!busy;
    if (elements.modeBack) elements.modeBack.disabled = !!busy;
    syncAdvancedSettingsState(!!busy);
    syncVerificationButtons();
    setProfileLocked(!!busy || session.active);
  }

  function pickerInputs(container, name) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    return Array.prototype.slice.call(
      container.querySelectorAll('input[name="' + name + '"]'));
  }

  function setPickerLocked(container, name, locked) {
    pickerInputs(container, name).forEach(function(input) {
      input.disabled = !!locked;
    });
  }

  function syncPickerCards(container, name, select) {
    if (!select) return;
    pickerInputs(container, name).forEach(function(input) {
      var selected = input.value === select.value;
      input.checked = selected;
      input.setAttribute("aria-checked", selected ? "true" : "false");
      if (typeof input.closest === "function") {
        var card = input.closest("[data-picker-option], label");
        if (card && card.dataset) card.dataset.selected = selected ? "true" : "false";
      }
    });
  }

  function syncHostPickerCards() {
    syncPickerCards(elements.mapOptions, "halo-map-choice", elements.map);
    syncPickerCards(elements.modeOptions, "halo-mode-choice", elements.mode);
  }

  function attachPickerEvents(container, name, select, onChange) {
    if (!container || !select) return;
    container.addEventListener("change", function(event) {
      var input = event.target;
      if (!input || input.name !== name || input.disabled) return;
      select.value = input.value;
      syncPickerCards(container, name, select);
      if (onChange) onChange();
    });
    select.addEventListener("change", function() {
      syncPickerCards(container, name, select);
      if (onChange) onChange();
    });
  }

  function profileStyleInputs() {
    if (!elements.styleOptions || typeof elements.styleOptions.querySelectorAll !== "function") {
      return [];
    }
    return Array.prototype.slice.call(
      elements.styleOptions.querySelectorAll('input[name="player-style"]'));
  }

  function setProfileLocked(locked) {
    if (elements.playerName) elements.playerName.disabled = !!locked;
    profileStyleInputs().forEach(function(input) { input.disabled = !!locked; });
  }

  function generatedPlayerName() {
    var value = Math.floor(Math.random() * 900) + 100;
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === "function") {
        var random = new Uint16Array(1);
        global.crypto.getRandomValues(random);
        value = 100 + (random[0] % 900);
      }
    } catch (error) {
      /* A friendly fallback does not require cryptographic randomness. */
    }
    return "Spartan " + value;
  }

  function normalizePlayerProfile(value) {
    var source = value || {};
    var name = String(source.name || "").replace(/\s+/g, " ").trim();
    var style = String(source.style || "sage").toLowerCase();
    if (name.length < 1 || name.length > PLAYER_NAME_MAXIMUM_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/.test(name)) {
      throw new Error("Use 1–11 basic letters or numbers for your player name.");
    }
    if (PLAYER_STYLES.indexOf(style) < 0) {
      throw new Error("Choose a valid player style.");
    }
    return { name: name, style: style };
  }

  function selectedPlayerStyle() {
    var inputs = profileStyleInputs();
    var selected = inputs.find(function(input) { return input.checked; });
    return selected ? selected.value : "sage";
  }

  function renderPlayerProfilePreview(profile) {
    if (elements.profilePreview) elements.profilePreview.dataset.style = profile.style;
    if (elements.profilePreviewName) elements.profilePreviewName.textContent = profile.name;
    if (elements.spartanImage) {
      if (elements.spartanImage.dataset.style !== profile.style) {
        elements.spartanImage.src = "assets/ui/spartan/" + profile.style + ".png";
        elements.spartanImage.dataset.style = profile.style;
      }
      elements.spartanImage.alt = profile.name + " in " + profile.style + " armor";
    }
  }

  function writePlayerProfile(profile) {
    if (elements.playerName) elements.playerName.value = profile.name;
    profileStyleInputs().forEach(function(input) {
      input.checked = input.value === profile.style;
    });
    renderPlayerProfilePreview(profile);
  }

  function readPlayerProfile() {
    return normalizePlayerProfile({
      name: elements.playerName ? elements.playerName.value :
        (session.profile && session.profile.name),
      style: selectedPlayerStyle(),
    });
  }

  function savePlayerProfile(profile) {
    session.profile = profile;
    writePlayerProfile(profile);
    try {
      global.localStorage.setItem(PLAYER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch (error) {
      /* A blocked store should never prevent joining a game. */
    }
    updateLocalRoster();
  }

  function restorePlayerProfile() {
    var profile = { name: generatedPlayerName(), style: "sage" };
    try {
      var saved = JSON.parse(global.localStorage.getItem(PLAYER_PROFILE_STORAGE_KEY));
      profile = normalizePlayerProfile(saved);
    } catch (error) {
      /* First-time and stale profiles get a friendly, editable default. */
    }
    savePlayerProfile(profile);
  }

  function applyPlayerCustomization(profile) {
    var fn = global.Module && global.Module._platform_web_online_set_player_customization;
    if (typeof fn !== "function") return;
    var args = [PLAYER_STYLE_COLORS[profile.style]];
    for (var index = 0; index < PLAYER_NAME_MAXIMUM_LENGTH; index++) {
      args.push(index < profile.name.length ? profile.name.charCodeAt(index) : 0);
    }
    if (!fn.apply(null, args)) {
      throw new Error("Halo could not apply your player customization.");
    }
  }

  function setWizardStep(step) {
    session.wizardStep = step;
    if (elements.wizard) elements.wizard.dataset.step = step;
    if (elements.stepMap) elements.stepMap.hidden = step !== "map";
    if (elements.stepMode) elements.stepMode.hidden = step !== "mode";
    /* The invite lives in the persistent player sidebar once hosting starts;
       it is not a third wizard step. Keep these guards for stale shells while
       allowing the Link markup to be removed entirely. */
    if (elements.stepLink) elements.stepLink.hidden = true;
    if (elements.wizardLink) elements.wizardLink.hidden = true;
    var order = ["map", "mode"];
    var current = order.indexOf(step);
    [elements.wizardMap, elements.wizardMode]
      .forEach(function(indicator, index) {
        if (!indicator) return;
        if (index === current) indicator.setAttribute("aria-current", "step");
        else indicator.removeAttribute("aria-current");
        indicator.dataset.complete = index < current ? "true" : "false";
      });
  }

  function playerFallbackName(player) {
    if (player.peerId === session.selfPeerId && session.profile) return session.profile.name;
    return player.role === "host" ? "Host" : "Joining…";
  }

  function normalizedRosterPlayer(value) {
    if (!value || typeof value.peerId !== "string" ||
        !/^[hg]_[A-Za-z0-9_-]{16}$/.test(value.peerId) ||
        (value.role !== "host" && value.role !== "guest")) return null;
    var profile = null;
    if (value.profile !== null && value.profile !== undefined) {
      try { profile = normalizePlayerProfile(value.profile); } catch (error) { return null; }
    }
    return { peerId: value.peerId, role: value.role, profile: profile };
  }

  function renderRoster() {
    if (!elements.playerSidebar) return;
    elements.playerSidebar.hidden = false;
    elements.playerSidebar.dataset.onlineActive = session.active ? "true" : "false";
    if (!session.active && elements.playerSidebar.dataset.collapsed === "true") {
      delete elements.playerSidebar.dataset.collapsed;
      if (elements.playerSidebarToggle) {
        elements.playerSidebarToggle.setAttribute("aria-expanded", "true");
        elements.playerSidebarToggle.setAttribute("aria-label", "Collapse player list");
        elements.playerSidebarToggle.textContent = "⌃";
      }
    }
    var players = Array.from(session.roster.values());
    players.sort(function(left, right) {
      if (left.role !== right.role) return left.role === "host" ? -1 : 1;
      var leftName = left.profile ? left.profile.name : playerFallbackName(left);
      var rightName = right.profile ? right.profile.name : playerFallbackName(right);
      return leftName.localeCompare(rightName);
    });
    if (elements.playerCount) {
      elements.playerCount.textContent = players.length + "/" + ROOM_CAPACITY;
      elements.playerCount.setAttribute(
        "aria-label",
        "Players in room: " + players.length + " of " + ROOM_CAPACITY);
    }
    if (elements.playerEmpty) elements.playerEmpty.hidden = players.length !== 0;
    if (elements.playerList && typeof document.createElement === "function") {
      while (elements.playerList.firstChild) elements.playerList.removeChild(elements.playerList.firstChild);
      players.forEach(function(player) {
        var profile = player.profile || {
          name: playerFallbackName(player),
          style: player.peerId === session.selfPeerId && session.profile ?
            session.profile.style : "sage",
        };
        var row = document.createElement("li");
        row.className = "player-row";
        row.dataset.style = profile.style;
        row.dataset.role = player.role;
        row.dataset.self = player.peerId === session.selfPeerId ? "true" : "false";
        var swatch = document.createElement("span");
        swatch.className = "player-swatch";
        swatch.setAttribute("aria-hidden", "true");
        var label = document.createElement("span");
        label.className = "player-name";
        label.textContent = profile.name;
        var role = document.createElement("span");
        role.className = "player-role";
        role.textContent = player.peerId === session.selfPeerId ? "You" :
          (player.role === "host" ? "Host" : "Player");
        row.appendChild(swatch);
        row.appendChild(label);
        row.appendChild(role);
        elements.playerList.appendChild(row);
      });
    }
  }

  function replaceRoster(players) {
    if (!Array.isArray(players) || players.length > ROOM_CAPACITY) return;
    var next = new Map();
    players.forEach(function(value) {
      var player = normalizedRosterPlayer(value);
      if (player) next.set(player.peerId, player);
    });
    session.roster = next;
    updateLocalRoster();
    renderRoster();
  }

  function updateLocalRoster() {
    if (!session.selfPeerId || !session.profile || !session.role) return;
    session.roster.set(session.selfPeerId, {
      peerId: session.selfPeerId,
      profile: session.profile,
      role: session.role,
    });
    renderRoster();
  }

  function selectHasIndex(select, index) {
    return Array.prototype.some.call(select.options, function(option) {
      return option.value === String(index);
    });
  }

  function validatedIndex(value, maximum, select, label) {
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error("Choose a " + label + ".");
    }
    var index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index > maximum ||
        !selectHasIndex(select, index)) {
      throw new Error("Choose a valid " + label + ".");
    }
    return index;
  }

  function selectedLabel(select, index) {
    var option = Array.prototype.find.call(select.options, function(candidate) {
      return candidate.value === String(index);
    });
    return option ? option.textContent.trim() : "";
  }

  function integerSetting(value, minimum, maximum, label) {
    var parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(label + " must be between " + minimum + " and " + maximum + ".");
    }
    return parsed;
  }

  function advancedDefaults(modeIndex) {
    var preset = ADVANCED_MODE_DEFAULTS[modeIndex] || ADVANCED_MODE_DEFAULTS[0];
    return {
      scoreToWin: preset.scoreToWin,
      respawnSeconds: preset.respawnSeconds,
      lives: 0,
      healthPercent: 100,
      infiniteGrenades: false,
      shields: true,
      invisiblePlayers: false,
      otherPlayersOnRadar: true,
    };
  }

  function normalizeAdvancedSettings(value, modeIndex) {
    if (!value) return null;
    var defaults = advancedDefaults(modeIndex);
    return {
      scoreToWin: integerSetting(value.scoreToWin, 1, 1000, "Score to win"),
      respawnSeconds: integerSetting(value.respawnSeconds, 0, 30, "Respawn delay"),
      lives: integerSetting(value.lives, 0, 99, "Lives"),
      healthPercent: integerSetting(value.healthPercent, 25, 400, "Health"),
      infiniteGrenades: value.infiniteGrenades === undefined ?
        defaults.infiniteGrenades : !!value.infiniteGrenades,
      shields: value.shields === undefined ? defaults.shields : !!value.shields,
      invisiblePlayers: value.invisiblePlayers === undefined ?
        defaults.invisiblePlayers : !!value.invisiblePlayers,
      otherPlayersOnRadar: value.otherPlayersOnRadar === undefined ?
        defaults.otherPlayersOnRadar : !!value.otherPlayersOnRadar,
    };
  }

  function readAdvancedSettings(modeIndex) {
    if (!elements.advancedEnabled || !elements.advancedEnabled.checked) return null;
    return normalizeAdvancedSettings({
      scoreToWin: elements.scoreToWin.value,
      respawnSeconds: elements.respawnSeconds.value,
      lives: elements.lives.value,
      healthPercent: elements.healthPercent.value,
      infiniteGrenades: elements.infiniteGrenades.checked,
      shields: elements.shields.checked,
      invisiblePlayers: elements.invisiblePlayers.checked,
      otherPlayersOnRadar: elements.otherPlayersOnRadar.checked,
    }, modeIndex);
  }

  function writeAdvancedSettings(value, modeIndex) {
    if (!elements.advancedEnabled || !elements.advancedFields) return;
    var settings = value ? normalizeAdvancedSettings(value, modeIndex) : advancedDefaults(modeIndex);
    elements.advancedEnabled.checked = !!value;
    elements.scoreToWin.value = String(settings.scoreToWin);
    elements.respawnSeconds.value = String(settings.respawnSeconds);
    elements.lives.value = String(settings.lives);
    elements.healthPercent.value = String(settings.healthPercent);
    elements.infiniteGrenades.checked = settings.infiniteGrenades;
    elements.shields.checked = settings.shields;
    elements.invisiblePlayers.checked = settings.invisiblePlayers;
    elements.otherPlayersOnRadar.checked = settings.otherPlayersOnRadar;
    syncAdvancedSettingsState(false);
  }

  function syncAdvancedSettingsState(busy) {
    if (!elements.advancedEnabled || !elements.advancedFields) return;
    elements.advancedEnabled.disabled = !!busy;
    elements.advancedFields.disabled = !!busy || !elements.advancedEnabled.checked;
    elements.advancedFields.dataset.enabled = elements.advancedEnabled.checked ? "true" : "false";
  }

  function resetAdvancedDefaultsForMode() {
    if (!elements.mode || !elements.advancedEnabled || elements.advancedEnabled.checked) return;
    var modeIndex = validatedIndex(elements.mode.value, LAST_MODE_INDEX, elements.mode, "mode");
    writeAdvancedSettings(null, modeIndex);
  }

  function normalizeHostSettings(value) {
    var source = value || {
      mapIndex: elements.map.value,
      modeIndex: elements.mode.value,
    };
    var mapIndex = validatedIndex(source.mapIndex, LAST_MAP_INDEX, elements.map, "map");
    var modeIndex = validatedIndex(source.modeIndex, LAST_MODE_INDEX, elements.mode, "mode");
    return {
      mapIndex: mapIndex,
      modeIndex: modeIndex,
      mapName: selectedLabel(elements.map, mapIndex),
      modeName: selectedLabel(elements.mode, modeIndex),
      advanced: value ? normalizeAdvancedSettings(source.advanced, modeIndex) :
        readAdvancedSettings(modeIndex),
    };
  }

  function restoreHostSettings() {
    elements.map.value = "0";
    elements.mode.value = "0";
    try {
      var saved = JSON.parse(global.localStorage.getItem(HOST_SETTINGS_STORAGE_KEY));
      var settings = normalizeHostSettings(saved);
      elements.map.value = String(settings.mapIndex);
      elements.mode.value = String(settings.modeIndex);
      writeAdvancedSettings(settings.advanced, settings.modeIndex);
    } catch (error) {
      /* Missing, blocked, or stale storage falls back to Battle Creek + Slayer. */
      writeAdvancedSettings(null, 0);
    }
    syncHostPickerCards();
  }

  function saveHostSettings(settings) {
    try {
      var saved = {
        mapIndex: settings.mapIndex,
        modeIndex: settings.modeIndex,
      };
      if (settings.advanced) saved.advanced = settings.advanced;
      global.localStorage.setItem(HOST_SETTINGS_STORAGE_KEY, JSON.stringify(saved));
    } catch (error) {
      /* Private browsing may make local storage unavailable; hosting still works. */
    }
  }

  function hostSettingsLabel() {
    return session.hostSettings ?
      session.hostSettings.mapName + " · " + session.hostSettings.modeName :
      "Your game";
  }

  function connectedFriendsLabel(count) {
    return count === 1 ? "1 friend connected" : count + " friends connected";
  }

  function requireCurrentOperation(generation) {
    if (generation !== session.operationGeneration || !session.active || session.closing) {
      var error = new Error("Online operation was canceled.");
      error.haloCanceled = true;
      throw error;
    }
  }

  function isCurrentSocketOperation(socketGeneration, operationGeneration) {
    return socketGeneration === session.socketGeneration &&
      operationGeneration === session.operationGeneration &&
      session.active && !session.closing;
  }

  function showSetup() {
    session.joinRequested = false;
    if (elements.dialog) elements.dialog.dataset.view = "setup";
    if (elements.wizardSteps) elements.wizardSteps.hidden = false;
    elements.setup.hidden = false;
    elements.invite.hidden = true;
    elements.progress.hidden = true;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
    setWizardStep("map");
    setProfileLocked(false);
    renderTurnstile("create_room");
    setStatus("");
    elements.description.textContent =
      "Pick a map and mode, then send the invite link to your friends.";
  }

  function showProgress() {
    if (elements.dialog) elements.dialog.dataset.view = "progress";
    if (elements.wizardSteps) elements.wizardSteps.hidden = session.role === "guest";
    elements.setup.hidden = true;
    elements.invite.hidden = true;
    elements.progress.hidden = false;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
  }

  function showInvite() {
    if (elements.wizardSteps) elements.wizardSteps.hidden = true;
    elements.setup.hidden = true;
    elements.progress.hidden = true;
    elements.invite.hidden = false;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
    if (elements.playerSidebar) elements.playerSidebar.hidden = false;
    elements.inviteLink.value = session.inviteUrl || "";
    /* Hosting setup is complete. The invite remains visible beside the game,
       so dismiss the wizard instead of replacing it with a third screen. */
    if (elements.dialog.open) elements.dialog.close();
  }

  function showJoinConfirmation(invite) {
    session.pendingInvite = invite;
    if (elements.dialog) elements.dialog.dataset.view = "join";
    if (elements.wizardSteps) elements.wizardSteps.hidden = true;
    elements.setup.hidden = true;
    elements.invite.hidden = true;
    elements.progress.hidden = true;
    if (elements.joinConfirm) elements.joinConfirm.hidden = false;
    if (elements.joinSummary) elements.joinSummary.textContent =
      "Choose your name and color, then join your friend's game.";
    elements.description.textContent = "You're invited.";
    setHeader("Ready to join", "waiting");
    setStatus(session.runtimeReady ? "" : "Loading Halo…");
    setProfileLocked(false);
    renderTurnstile("join_room");
    setBusy(false);
  }

  function parseInvite(value) {
    var text = String(value || "").trim();
    if (!text || text.length > 1024) throw new Error("Paste a valid invite link.");
    var nativeInvite = /^halo:\/\/join\/([0-9a-fA-F]{64})$/.exec(text);
    if (nativeInvite) {
      return {
        code: "halo://join/" + nativeInvite[1].toLowerCase(),
        kind: "native",
      };
    }
    try {
      var url = new URL(text);
      if (url.protocol.toLowerCase() === "halo:") {
        if (url.hostname.toLowerCase() !== "join" ||
            !/^\/[0-9a-fA-F]{64}$/.test(url.pathname)) {
          throw new Error("That Halo invite link is not valid.");
        }
        return {
          code: "halo://join/" + url.pathname.slice(1).toLowerCase(),
          kind: "native",
        };
      }
      var fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
      text = fragment.get("join") || "";
    } catch (error) {
      if (error && error.message === "That Halo invite link is not valid.") throw error;
      /* A room code is expected not to be a URL. */
    }
    try {
      text = decodeURIComponent(text);
    } catch (error) {
      throw new Error("That invite link is malformed.");
    }
    var separator = text.indexOf(".");
    if (separator <= 0 || separator === text.length - 1) {
      throw new Error("That invite link is incomplete.");
    }
    var roomId = text.slice(0, separator);
    var ticket = text.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(roomId) ||
        !/^[A-Za-z0-9_-]{16,256}$/.test(ticket)) {
      throw new Error("That invite link is not valid.");
    }
    return { code: text, kind: "web", roomId: roomId, ticket: ticket };
  }

  function takeInviteFromLocation() {
    var fragment = new URLSearchParams(global.location.hash.replace(/^#/, ""));
    var invite = fragment.get("join");
    if (!invite) return null;
    /* Capabilities in fragments do not reach the server.  Remove it from the
       address bar as soon as this page has copied it into memory. */
    var sanitized = new URL(global.location.href);
    sanitized.hash = "";
    sanitized.searchParams.delete("signal");
    history.replaceState(null, "", sanitized.pathname + sanitized.search);
    return invite;
  }

  function makeInviteUrl(code) {
    var url = new URL(global.location.href);
    url.searchParams.delete("signal");
    url.hash = "join=" + encodeURIComponent(code);
    return url.href;
  }

  async function fetchJson(path, options) {
    var response;
    try {
      response = await fetch(apiBase() + path, Object.assign({
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
      }, options || {}));
    } catch (error) {
      throw new Error("The private-room service is unreachable.");
    }
    var result = null;
    try {
      result = await response.json();
    } catch (error) {
      /* A proxy error page is not useful to the player. */
    }
    if (!response.ok) {
      var message = result && result.error &&
        (result.error.message || (typeof result.error === "string" && result.error));
      if (response.status === 404) message = "That invite expired or is not valid.";
      if (response.status === 409 && !message) message = "That room is full or no longer available.";
      var requestError = new Error(message || "The private-room service rejected the request.");
      requestError.haloCode = result && result.error && result.error.code;
      requestError.haloStatus = response.status;
      throw requestError;
    }
    return result;
  }

  function wasmFunction(name) {
    var fn = global.Module && global.Module["_" + name];
    if (typeof fn !== "function") throw new Error("Halo is still starting.");
    return fn;
  }

  function requestGame(command) {
    if (!wasmFunction("platform_web_online_request")(command)) {
      throw new Error("Halo could not accept the online-play request.");
    }
  }

  function requestConfiguredHost(settings) {
    var accepted;
    if (settings.advanced) {
      var rules = (settings.advanced.infiniteGrenades ? 1 : 0) |
        (settings.advanced.shields ? 2 : 0) |
        (settings.advanced.invisiblePlayers ? 4 : 0) |
        (settings.advanced.otherPlayersOnRadar ? 8 : 0);
      accepted = wasmFunction("platform_web_online_host_advanced_configured")(
        settings.mapIndex,
        settings.modeIndex,
        settings.advanced.scoreToWin,
        settings.advanced.respawnSeconds,
        settings.advanced.lives,
        settings.advanced.healthPercent,
        rules);
    } else {
      accepted = wasmFunction("platform_web_online_host_configured")(
        settings.mapIndex, settings.modeIndex);
    }
    if (!accepted) {
      throw new Error("Halo could not accept those host settings.");
    }
  }

  function gameState() {
    return wasmFunction("platform_web_online_get_state")();
  }

  function gameError() {
    return wasmFunction("platform_web_online_get_error")();
  }

  function setGameTransportState(value) {
    if (!session.runtimeReady) return;
    wasmFunction("platform_web_online_set_transport_state")(value);
  }

  function transport() {
    if (!global.HaloWebTransport || !global.HaloWebTransport.isSupported()) {
      throw new Error("This browser does not support WebRTC multiplayer.");
    }
    return global.HaloWebTransport;
  }

  function localIdentifier() {
    return transport().getLocalIdentifier();
  }

  function wireSignal(signal) {
    if (signal && signal.description) {
      return { kind: "description", description: signal.description };
    }
    if (signal && Object.prototype.hasOwnProperty.call(signal, "candidate")) {
      return { kind: "candidate", candidate: signal.candidate };
    }
    throw new Error("WebRTC produced an unsupported signal.");
  }

  function transportSignal(signal) {
    if (!signal || typeof signal !== "object") throw new Error("The host sent an invalid signal.");
    if (signal.kind === "description") return { description: signal.description };
    if (signal.kind === "candidate") return { candidate: signal.candidate };
    /* Accept the direct transport shape for local/older signalling servers. */
    if (signal.description || Object.prototype.hasOwnProperty.call(signal, "candidate")) return signal;
    throw new Error("The host sent an unsupported signal.");
  }

  function sendSocket(message) {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The room connection is temporarily unavailable.");
    }
    session.socket.send(JSON.stringify(message));
  }

  function configureTransport(iceServers) {
    transport().configure({
      iceServers: iceServers || [],
      onSignal: function(event) {
        if (!session.active || session.closing || !event ||
            !session.peerPromises.has(event.peerId)) return;
        sendSocket({
          v: PROTOCOL_VERSION,
          type: "signal",
          to: session.peerSignalTargets.get(event.peerId) || event.peerId,
          signal: wireSignal(event.signal),
        });
      },
      onStateChange: function(event) {
        handleTransportState(event);
      },
      onError: function(event) {
        var message = event && event.error && event.error.message ?
          event.error.message : "The browser connection failed.";
        if (session.active) setStatus(message, "error");
      },
    });
  }

  function ensurePeer(peer, socketGeneration, operationGeneration) {
    if (!isCurrentSocketOperation(socketGeneration, operationGeneration)) {
      return Promise.resolve(null);
    }
    if (!peer || typeof peer.peerId !== "string" ||
        typeof peer.identifier !== "string" ||
        (peer.role !== "host" && peer.role !== "guest")) {
      return Promise.reject(new Error("The room returned an invalid peer."));
    }
    if (peer.peerId === session.selfPeerId) return Promise.resolve(null);
    /* Halo uses a host-client star. Guests never need guest-to-guest browser
       transports, even though older room services may announce every member. */
    if (peer.role === session.role) return Promise.resolve(null);
    var existing = session.peerPromises.get(peer.peerId);
    if (existing) return existing;
    var normalizedIdentifier = peer.identifier.toLowerCase();
    var connectedDuplicate = null;
    session.peerIdentifiers.forEach(function(identifier, peerId) {
      if (peerId !== peer.peerId && identifier === normalizedIdentifier) {
        if (session.peerStates.get(peerId) === "connected") {
          connectedDuplicate = peerId;
          return;
        }
        /* A refreshed browser receives a new signaling peer ID but retains its
           Halo network identifier. Replace the stale WebRTC transport before
           registering the new one so both cannot share one virtual address. */
        removePeer(peerId);
      }
    });
    if (connectedDuplicate) {
      session.peerAliases.set(peer.peerId, connectedDuplicate);
      session.peerSignalTargets.set(connectedDuplicate, peer.peerId);
      return session.peerPromises.get(connectedDuplicate) || Promise.resolve(null);
    }
    var rawAdding = transport().addPeer({
      peerId: peer.peerId,
      remoteIdentifier: normalizedIdentifier,
      initiator: session.role === "host",
      polite: session.role !== "host",
      iceServers: session.iceServers,
    });
    var adding = rawAdding.then(function(result) {
      if (!isCurrentSocketOperation(socketGeneration, operationGeneration)) {
        if (session.peerPromises.get(peer.peerId) === adding) removePeer(peer.peerId);
        var error = new Error("Peer registration was canceled.");
        error.haloCanceled = true;
        throw error;
      }
      return result;
    });
    session.peerIdentifiers.set(peer.peerId, normalizedIdentifier);
    session.peerPromises.set(peer.peerId, adding);
    session.peerAliases.set(peer.peerId, peer.peerId);
    session.peerSignalTargets.set(peer.peerId, peer.peerId);
    adding.catch(function() {
      if (session.peerPromises.get(peer.peerId) === adding) {
        session.peerPromises.delete(peer.peerId);
        session.peerIdentifiers.delete(peer.peerId);
        session.peerAliases.delete(peer.peerId);
        session.peerSignalTargets.delete(peer.peerId);
      }
    });
    return adding;
  }

  function removePeer(peerId) {
    var transportPeerId = session.peerAliases.get(peerId) || peerId;
    session.peerAliases.forEach(function(mappedPeerId, signalingPeerId) {
      if (mappedPeerId === transportPeerId) session.peerAliases.delete(signalingPeerId);
    });
    session.peerSignalTargets.delete(transportPeerId);
    session.peerPromises.delete(transportPeerId);
    session.peerIdentifiers.delete(transportPeerId);
    session.peerStates.delete(transportPeerId);
    transport().removePeer(transportPeerId);
    updateAggregateTransportState();
  }

  function updateAggregateTransportState() {
    var values = Array.from(session.peerStates.values());
    var connected = values.filter(function(value) { return value === "connected"; }).length;
    var connecting = values.some(function(value) { return value === "connecting"; });
    var failed = values.some(function(value) { return value === "failed"; });
    session.connectedPeerCount = connected;
    session.transportConnected = connected > 0;
    if (session.transportConnected) setGameTransportState(TRANSPORT_STATE.CONNECTED);
    else if (connecting) setGameTransportState(TRANSPORT_STATE.CONNECTING);
    else if (failed) setGameTransportState(TRANSPORT_STATE.FAILED);
    else setGameTransportState(TRANSPORT_STATE.DISCONNECTED);

    if (session.role === "host") {
      if (connected) {
        setHeader(connectedFriendsLabel(connected), "connected");
        setStatus(connected === 1 ?
          "Your friend is connected. Press Start Game in Halo when ready." :
          connected + " friends are connected. Press Start Game in Halo when ready.");
      } else if (session.active) {
        setHeader("Waiting for friends", "waiting");
      }
    }
  }

  function handleTransportState(event) {
    if (!session.active || !event || !event.peerId ||
        !session.peerPromises.has(event.peerId)) return;
    session.peerStates.set(event.peerId, event.state);
    updateAggregateTransportState();
    if (event.state === "connected") {
      if (event.detail === "native-gateway") {
        session.connectionPath = "gateway";
        syncTelemetryContext();
        telemetry("transport_connected", "native-gateway");
        elements.detail.textContent = "Connected to a native Halo host";
      } else {
        determineConnectionPath(event.peerId);
      }
      if (session.role === "guest" && !session.gameCommandIssued) {
        try {
          applyPlayerCustomization(session.profile);
          requestGame(COMMAND.JOIN);
          session.gameCommandIssued = true;
          startGamePolling();
          setStatus("Connected. Finding your friend's Halo lobby…");
        } catch (error) {
          fail(error);
        }
      } else if (session.role === "host") {
        global.setTimeout(function() {
          if (elements.dialog.open && session.active) elements.dialog.close();
          var canvas = byId("canvas");
          if (canvas) canvas.focus();
        }, 700);
      }
    } else if (event.state === "connecting" && session.role === "guest") {
      setStatus(event.detail === "native-gateway" ?
        "Reaching the native Halo host…" : "Connecting directly to your friend…");
    } else if (event.state === "failed" && session.role === "guest") {
      fail(new Error(event.detail || "Could not connect to the host."));
    }
  }

  async function determineConnectionPath(peerId) {
    try {
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
      var reports = await transport().getStats(peerId);
      var selected = null;
      reports.forEach(function(report) {
        if (report.type === "candidate-pair" &&
            (report.selected || (report.nominated && report.state === "succeeded"))) {
          selected = report;
        }
      });
      if (!selected) return;
      var local = reports.get(selected.localCandidateId);
      var remote = reports.get(selected.remoteCandidateId);
      session.connectionPath =
        (local && local.candidateType === "relay") ||
        (remote && remote.candidateType === "relay") ? "relay" : "direct";
      syncTelemetryContext();
      telemetry("transport_connected", session.connectionPath);
      elements.detail.textContent = session.connectionPath === "relay" ?
        "Connected through a privacy-compatible relay" :
        "Connected directly peer-to-peer";
    } catch (error) {
      /* Connection-path reporting is diagnostic and never blocks play. */
    }
  }

  async function handleRoomMessage(message, generation, operation) {
    if (!isCurrentSocketOperation(generation, operation)) return;
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== "string") {
      throw new Error("The room service sent an incompatible message.");
    }
    if (message.type === "welcome") {
      session.selfPeerId = message.self && message.self.peerId;
      session.role = message.self && message.self.role;
      syncTelemetryContext();
      updateLocalRoster();
      var peers = Array.isArray(message.peers) ? message.peers : [];
      await Promise.all(peers.map(function(peer) {
        return ensurePeer(peer, generation, operation);
      }));
      return;
    }
    if (message.type === "peer-joined") {
      var joined = normalizedRosterPlayer(message.peer);
      if (joined) {
        session.roster.set(joined.peerId, joined);
        renderRoster();
      }
      await ensurePeer(message.peer, generation, operation);
      return;
    }
    if (message.type === "peer-left") {
      session.roster.delete(message.peerId);
      renderRoster();
      var departedTransportPeerId = session.peerAliases.get(message.peerId) || message.peerId;
      if (session.peerStates.get(departedTransportPeerId) === "connected") {
        session.peerAliases.delete(message.peerId);
        if (session.peerSignalTargets.get(departedTransportPeerId) === message.peerId) {
          session.peerSignalTargets.delete(departedTransportPeerId);
        }
        elements.detail.textContent =
          "Gameplay is still connected directly; the room link closed.";
        return;
      }
      removePeer(departedTransportPeerId);
      if (session.role === "guest" && message.reason === "host-disconnected") {
        fail(new Error("The host closed the room."));
      }
      return;
    }
    if (message.type === "roster") {
      replaceRoster(message.players);
      return;
    }
    if (message.type === "signal") {
      var transportPeerId = session.peerAliases.get(message.from) || message.from;
      var peerPromise = session.peerPromises.get(transportPeerId);
      if (!peerPromise) {
        /* A rejected guest can have another frame already in flight. It must
           not turn a peer-scoped failure into destruction of the host room. */
        if (session.role === "host") return;
        throw new Error("A signal arrived from an unknown host.");
      }
      try {
        await peerPromise;
        if (!isCurrentSocketOperation(generation, operation)) return;
        await transport().handleSignal(transportPeerId, transportSignal(message.signal));
      } catch (error) {
        if (!isCurrentSocketOperation(generation, operation)) return;
        removePeer(transportPeerId);
        if (session.role === "guest") throw error;
        setStatus("A guest sent invalid connection data and was disconnected.", "error");
      }
      return;
    }
    if (message.type === "error") {
      if (session.role === "host" &&
          (message.code === "PEER_NOT_FOUND" ||
           message.code === "SIGNAL_ROUTE_FORBIDDEN" ||
           message.code === "SIGNAL_DIRECTION_INVALID")) {
        /* A late or rejected guest signal is peer-scoped. The private host
           lobby remains usable for a fresh connection. */
        return;
      }
      throw new Error(message.message || "The private room reported an error.");
    }
    /* pong and future optional messages need no action. */
  }

  function websocketUrl(value) {
    var service = new URL(apiBase());
    var url = new URL(value, service);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    var expectedProtocol = service.protocol === "https:" ? "wss:" : "ws:";
    if (url.protocol !== expectedProtocol || url.host !== service.host) {
      throw new Error("The room returned an invalid WebSocket URL.");
    }
    return url.href;
  }

  function stopHeartbeat() {
    if (session.heartbeatTimer) global.clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = 0;
  }

  function startHeartbeat(generation) {
    stopHeartbeat();
    session.heartbeatTimer = global.setInterval(function() {
      if (generation !== session.socketGeneration || !session.active) return;
      try {
        sendSocket({ v: PROTOCOL_VERSION, type: "ping", nonce: String(Date.now()) });
      } catch (error) {
        /* The close event owns reconnect behavior. */
      }
    }, HEARTBEAT_MILLISECONDS);
  }

  function openSocket(socketUrl, operation) {
    return new Promise(function(resolve, reject) {
      var generation = ++session.socketGeneration;
      var socket;
      try {
        socket = new WebSocket(websocketUrl(socketUrl));
      } catch (error) {
        reject(error);
        return;
      }
      session.socket = socket;
      var settled = false;
      var pendingMessageCount = 0;
      var messageChain = Promise.resolve();
      session.messageChain = messageChain;
      var timeout = global.setTimeout(function() {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error("The private room took too long to connect."));
        }
      }, 12000);
      socket.onopen = function() {
        if (!isCurrentSocketOperation(generation, operation)) {
          global.clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(new Error("The room connection was canceled."));
          }
          socket.close();
          return;
        }
        global.clearTimeout(timeout);
        try {
          sendSocket({
            v: PROTOCOL_VERSION,
            type: "profile",
            profile: session.profile,
          });
        } catch (error) {
          settled = true;
          socket.close();
          reject(error);
          return;
        }
        settled = true;
        session.reconnectAttempts = 0;
        startHeartbeat(generation);
        resolve();
      };
      socket.onmessage = function(event) {
        if (!isCurrentSocketOperation(generation, operation) || typeof event.data !== "string") return;
        pendingMessageCount++;
        if (pendingMessageCount > MAX_PENDING_SIGNALING_MESSAGES) {
          socket.close(1008, "Too many pending signaling messages");
          fail(new Error("The room sent too many connection messages."));
          return;
        }
        var message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          pendingMessageCount--;
          if (isCurrentSocketOperation(generation, operation)) {
            fail(new Error("The private room sent malformed data."));
          }
          return;
        }
        messageChain = messageChain.then(function() {
          return handleRoomMessage(message, generation, operation);
        }).catch(function(error) {
          if (isCurrentSocketOperation(generation, operation)) fail(error);
        }).finally(function() {
          pendingMessageCount--;
        });
        session.messageChain = messageChain;
      };
      socket.onerror = function() {
        if (!settled) {
          global.clearTimeout(timeout);
          settled = true;
          reject(new Error("The private room WebSocket could not connect."));
        }
      };
      socket.onclose = function() {
        if (!settled) {
          global.clearTimeout(timeout);
          settled = true;
          reject(new Error("The room connection closed before it was ready."));
          return;
        }
        if (generation !== session.socketGeneration ||
            operation !== session.operationGeneration) return;
        stopHeartbeat();
        if (session.transportConnected && session.role !== "host") {
          elements.detail.textContent =
            "Gameplay is still connected directly; restoring the room link…";
        }
        if (session.active && !session.closing) scheduleReconnect();
      };
    });
  }

  async function createSession(ticket, turnstileToken) {
    var body = {
      protocolVersion: PROTOCOL_VERSION,
      buildId: buildId(),
      identifier: localIdentifier(),
      ticket: ticket,
    };
    if (turnstileToken) body.turnstileToken = turnstileToken;
    return fetchJson("/v1/rooms/" + encodeURIComponent(session.room.id) + "/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async function createNativeSession(invite, turnstileToken) {
    var body = {
      protocolVersion: PROTOCOL_VERSION,
      buildId: buildId(),
      identifier: localIdentifier(),
      invite: invite,
    };
    if (turnstileToken) body.turnstileToken = turnstileToken;
    return fetchJson("/v1/native/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  function validateNativeSessionResponse(result) {
    var descriptor = result && result.session;
    if (!result || result.v !== PROTOCOL_VERSION || result.kind !== "native" ||
        !descriptor || typeof descriptor.peerId !== "string" ||
        !/^[0-9a-f]{12}$/.test(descriptor.localIdentifier || "") ||
        !/^[0-9a-f]{12}$/.test(descriptor.remoteIdentifier || "") ||
        !/^wss:\/\//i.test(descriptor.websocketUrl || "") ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(descriptor.ticket || "")) {
      throw new Error("The native gateway returned an incomplete response.");
    }
  }

  async function connectNativeInvite(invite, turnstileToken, operation) {
    var result = await createNativeSession(invite.code, turnstileToken);
    requireCurrentOperation(operation);
    validateNativeSessionResponse(result);
    var descriptor = result.session;
    await transport().setLocalIdentifier(descriptor.localIdentifier);
    session.room = { id: "native" };
    session.roomTicket = null;
    session.selfPeerId = "native-self-" + descriptor.localIdentifier;
    session.connectionPath = "gateway";
    syncTelemetryContext();
    updateLocalRoster();
    session.roster.set(descriptor.peerId, {
      peerId: descriptor.peerId,
      profile: null,
      role: "host",
    });
    renderRoster();
    configureTransport([]);
    var adding = transport().addGatewayPeer({
      peerId: descriptor.peerId,
      remoteIdentifier: descriptor.remoteIdentifier,
      ticket: descriptor.ticket,
      websocketUrl: descriptor.websocketUrl,
    });
    session.peerIdentifiers.set(descriptor.peerId, descriptor.remoteIdentifier);
    session.peerPromises.set(descriptor.peerId, adding);
    session.peerAliases.set(descriptor.peerId, descriptor.peerId);
    try {
      await adding;
      requireCurrentOperation(operation);
    } catch (error) {
      if (session.peerPromises.get(descriptor.peerId) === adding) {
        session.peerPromises.delete(descriptor.peerId);
        session.peerIdentifiers.delete(descriptor.peerId);
        session.peerAliases.delete(descriptor.peerId);
      }
      throw error;
    }
    setGameTransportState(TRANSPORT_STATE.CONNECTING);
    setStatus("Invite accepted. Reaching the native host…");
  }

  function scheduleReconnect() {
    if (!session.active || session.closing || session.reconnectTimer) return;
    var operation = session.operationGeneration;
    var delay = Math.min(8000, 500 * Math.pow(2, session.reconnectAttempts++));
    session.reconnectTimer = global.setTimeout(function() {
      session.reconnectTimer = 0;
      if (operation !== session.operationGeneration || !session.active) return;
      reconnect(operation).catch(function(error) {
        if (operation !== session.operationGeneration) return;
        if (session.transportConnected) {
          elements.detail.textContent = "Gameplay is connected; room recovery is still retrying.";
          scheduleReconnect();
        /* A failed WebSocket upgrade can leave its 30-second server-side
           reservation in place. Keep retrying long enough to outlive it. */
        } else if (session.reconnectAttempts < 7) {
          scheduleReconnect();
        } else {
          fail(error);
        }
      });
    }, delay);
  }

  async function reconnect(operation) {
    if (!session.transportConnected) {
      /* The replacement signaling session gets a new peer ID. Any WebRTC
         negotiation that never connected belongs to the old identity and
         must be rebuilt so the host produces a fresh offer. */
      Array.from(session.peerPromises.keys()).forEach(removePeer);
    }
    var result = await createSession(session.roomTicket);
    requireCurrentOperation(operation);
    if (Array.isArray(result.iceServers)) session.iceServers = result.iceServers;
    configureTransport(session.iceServers);
    await openSocket(result.session.websocketUrl, operation);
    requireCurrentOperation(operation);
    elements.detail.textContent = session.connectionPath === "relay" ?
      "Connected through a relay" : "Connected peer-to-peer";
  }

  function validateRoomResponse(result) {
    if (!result || result.v !== PROTOCOL_VERSION || !result.room ||
        !result.session || !result.session.websocketUrl ||
        !result.session.peerId) {
      throw new Error("The room service returned an incomplete response.");
    }
  }

  function isTurnstileRejection(error) {
    return error && error.haloStatus === 403 && error.haloCode === "TURNSTILE_REJECTED";
  }

  async function recoverTurnstile(action, invite) {
    resetTurnstile();
    await leave(false);
    showDialog();
    if (action === "join_room") showJoinConfirmation(invite);
    else showSetup();
    setVerificationState(
      "error",
      "We couldn't verify you this time. Try again — you won't need to refresh.");
    setBusy(false);
  }

  async function host(value, turnstileToken) {
    if (!session.runtimeReady) throw new Error("Halo is still starting.");
    var settings = normalizeHostSettings(value);
    var profile = readPlayerProfile();
    saveHostSettings(settings);
    savePlayerProfile(profile);
    await leave(false);
    var operation = ++session.operationGeneration;
    session.active = true;
    session.role = "host";
    syncTelemetryContext();
    session.hostSettings = settings;
    session.closing = false;
    renderRoster();
    showDialog();
    showProgress();
    setBusy(true);
    setHeader("Opening room…", "waiting");
    setStatus("Preparing " + hostSettingsLabel() + "…");
    var recoveredVerification = false;
    try {
      var roomRequest = {
        protocolVersion: PROTOCOL_VERSION,
        buildId: buildId(),
        capacity: ROOM_CAPACITY,
        identifier: localIdentifier(),
      };
      if (turnstileToken) roomRequest.turnstileToken = turnstileToken;
      var result = await fetchJson("/v1/rooms", {
        method: "POST",
        body: JSON.stringify(roomRequest),
      });
      requireCurrentOperation(operation);
      var normalized = {
        v: result.v,
        room: result.room,
        session: result.host && result.host.session,
      };
      validateRoomResponse(normalized);
      session.room = result.room;
      session.roomTicket = result.host.ticket;
      session.selfPeerId = result.host.session.peerId;
      updateLocalRoster();
      session.inviteCode = result.invite && result.invite.code;
      if (!session.inviteCode) throw new Error("The room did not return an invite.");
      /* Keep the visible host and path that the player opened. This lets the
         same signaling service support a staged origin without leaking its
         canonical production URL into preview invites. */
      session.inviteUrl = makeInviteUrl(session.inviteCode);
      showInvite();
      session.iceServers = Array.isArray(result.iceServers) ? result.iceServers : [];
      configureTransport(session.iceServers);
      await openSocket(result.host.session.websocketUrl, operation);
      requireCurrentOperation(operation);
      applyPlayerCustomization(profile);
      requestConfiguredHost(settings);
      session.gameCommandIssued = true;
      startGamePolling();
      setHeader("Preparing lobby…", "waiting");
      setStatus("Opening Halo's lobby with " + hostSettingsLabel() + "…");
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) {
        if (isTurnstileRejection(error)) {
          recoveredVerification = true;
          await recoverTurnstile("create_room");
        } else {
          fail(error);
        }
      }
    } finally {
      if (!recoveredVerification) resetTurnstile();
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  async function join(value, turnstileToken) {
    if (!session.runtimeReady) {
      showDialog();
      showJoinConfirmation(value);
      return;
    }
    var profile = readPlayerProfile();
    savePlayerProfile(profile);
    await leave(false);
    var operation = ++session.operationGeneration;
    var invite;
    var recoveredVerification = false;
    try {
      invite = parseInvite(value);
    } catch (error) {
      fail(error);
      return;
    }
    session.active = true;
    session.role = "guest";
    syncTelemetryContext();
    session.closing = false;
    session.room = invite.kind === "native" ? { id: "native" } : { id: invite.roomId };
    session.roomTicket = invite.kind === "native" ? null : invite.ticket;
    session.profile = profile;
    writePlayerProfile(profile);
    showDialog();
    showProgress();
    setBusy(true);
    setHeader("Joining friend…", "waiting");
    setStatus("Opening your friend's private room…");
    try {
      if (invite.kind === "native") {
        await connectNativeInvite(invite, turnstileToken, operation);
        return;
      }
      var result = await createSession(invite.ticket, turnstileToken);
      requireCurrentOperation(operation);
      validateRoomResponse(result);
      session.room = result.room;
      session.selfPeerId = result.session.peerId;
      updateLocalRoster();
      session.iceServers = Array.isArray(result.iceServers) ? result.iceServers : [];
      configureTransport(session.iceServers);
      await openSocket(result.session.websocketUrl, operation);
      requireCurrentOperation(operation);
      setGameTransportState(TRANSPORT_STATE.CONNECTING);
      setStatus("Room found. Connecting directly to your friend…");
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) {
        if (isTurnstileRejection(error)) {
          recoveredVerification = true;
          await recoverTurnstile("join_room", value);
        } else {
          fail(error);
        }
      }
    } finally {
      if (!recoveredVerification) resetTurnstile();
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  function startGamePolling() {
    if (session.gamePollTimer) return;
    session.gamePollTimer = global.setInterval(pollGame, GAME_POLL_MILLISECONDS);
  }

  function stopGamePolling() {
    if (session.gamePollTimer) global.clearInterval(session.gamePollTimer);
    session.gamePollTimer = 0;
  }

  function pollGame() {
    if (!session.active || !session.runtimeReady || !session.gameCommandIssued) return;
    var state;
    try {
      state = gameState();
    } catch (error) {
      return;
    }
    elements.dialog.dataset.gameState = String(state);
    if (state === GAME_STATE.ERROR) {
      fail(new Error(GAME_ERRORS[gameError()] || "Halo could not enter the online lobby."));
      return;
    }
    if (session.role === "host") {
      if (state === GAME_STATE.HOSTING) {
        if (!session.hostWasReady) showInvite();
        session.hostWasReady = true;
        setHeader(session.connectedPeerCount ?
          connectedFriendsLabel(session.connectedPeerCount) : "Waiting for friends",
          session.connectedPeerCount ? "connected" : "waiting");
        setStatus(session.connectedPeerCount ?
          connectedFriendsLabel(session.connectedPeerCount) + ". " + hostSettingsLabel() +
            " is ready — press Start Game in Halo." :
          hostSettingsLabel() + " is ready — send the invite link to your friends.");
      } else if (state === GAME_STATE.WAITING) {
        setStatus("Waiting for Halo's main menu…");
      } else if (state === GAME_STATE.HOST_STARTING) {
        setStatus("Opening Halo's multiplayer lobby…");
      } else if (session.hostWasReady && state === GAME_STATE.IDLE) {
        leave(true);
      }
      return;
    }
    if (state === GAME_STATE.WAITING) {
      setStatus("Waiting for Halo's main menu…");
    } else if (state === GAME_STATE.JOIN_SEARCHING) {
      setStatus("Connected. Finding your friend's Halo lobby…");
    } else if (state === GAME_STATE.JOIN_CONNECTING) {
      setStatus("Halo found the lobby. Joining…");
    } else if (state === GAME_STATE.JOINED) {
      session.guestWasJoined = true;
      setHeader("Connected to friend", "connected");
      setStatus("You're in the lobby.");
      global.setTimeout(function() {
        if (elements.dialog.open && session.active) elements.dialog.close();
        var canvas = byId("canvas");
        if (canvas) canvas.focus();
      }, 700);
    } else if (session.guestWasJoined && state === GAME_STATE.IDLE) {
      leave(true);
    }
  }

  function resetSessionState() {
    session.active = false;
    session.role = null;
    session.room = null;
    session.roomTicket = null;
    session.inviteCode = null;
    session.inviteUrl = null;
    session.selfPeerId = null;
    session.iceServers = [];
    session.socket = null;
    session.reconnectAttempts = 0;
    session.gameCommandIssued = false;
    session.transportConnected = false;
    session.connectedPeerCount = 0;
    session.connectionPath = null;
    session.peerPromises.clear();
    session.peerIdentifiers.clear();
    session.peerStates.clear();
    session.peerAliases.clear();
    session.peerSignalTargets.clear();
    session.roster.clear();
    session.messageChain = Promise.resolve();
    session.hostWasReady = false;
    session.hostSettings = null;
    session.guestWasJoined = false;
    session.pendingInvite = null;
    session.joinRequested = false;
    session.wizardStep = "map";
    syncTelemetryContext();
    renderRoster();
  }

  async function leave(returnToSetup) {
    session.operationGeneration++;
    if (session.leavePromise) return session.leavePromise;
    session.leavePromise = (async function() {
      session.closing = true;
      var pendingWork = [session.messageChain].concat(Array.from(session.peerPromises.values()));
      if (session.role === "host" && session.room && session.roomTicket) {
        fetchJson("/v1/rooms/" + encodeURIComponent(session.room.id), {
          method: "DELETE",
          body: JSON.stringify({ ticket: session.roomTicket }),
        }).catch(function() {
          /* The room expires automatically if revocation cannot reach the service. */
        });
      }
      stopHeartbeat();
      stopGamePolling();
      if (session.reconnectTimer) global.clearTimeout(session.reconnectTimer);
      session.reconnectTimer = 0;
      session.socketGeneration++;
      if (session.socket) {
        try { session.socket.close(1000, "left room"); } catch (error) { /* closed */ }
      }
      if (global.HaloWebTransport) global.HaloWebTransport.disconnectAll();
      await Promise.allSettled(pendingWork);
      /* A peer registration can finish after the first disconnectAll(). Clear
         it before a replacement room is allowed to start. */
      if (global.HaloWebTransport) global.HaloWebTransport.disconnectAll();
      if (session.runtimeReady && session.gameCommandIssued) {
        try { requestGame(COMMAND.CANCEL); } catch (error) { /* runtime shutting down */ }
      }
      try { setGameTransportState(TRANSPORT_STATE.DISCONNECTED); } catch (error) { /* runtime unavailable */ }
      resetSessionState();
      setHeader("Play online", "offline");
      elements.detail.textContent = "Private invite room · gameplay connects peer-to-peer when possible";
      if (returnToSetup !== false) {
        showSetup();
        setBusy(false);
      }
    })();
    try {
      await session.leavePromise;
    } finally {
      session.leavePromise = null;
      session.closing = false;
    }
  }

  function fail(error) {
    var message = error && error.message ? error.message : "Online play failed.";
    telemetry("online_error", "online");
    var wasActive = session.active;
    leave(false).then(function() {
      showDialog();
      showSetup();
      setStatus(message, "error");
      setBusy(false);
    });
    if (!wasActive) {
      showDialog();
      showSetup();
      setStatus(message, "error");
    }
  }

  async function copyInvite() {
    var value = session.inviteUrl;
    if (!value) return;
    var copied = false;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch (error) {
      elements.inviteLink.focus();
      elements.inviteLink.select();
      try {
        copied = typeof document.execCommand === "function" &&
          document.execCommand("copy") === true;
      } catch (fallbackError) {
        copied = false;
      }
    }
    if (!copied) {
      elements.copy.textContent = "Copy link";
      if (elements.copyStatus) {
        elements.copyStatus.textContent = "Link selected — press ⌘/Ctrl+C to copy.";
        elements.copyStatus.hidden = false;
      }
      return;
    }
    if (elements.copyStatus) elements.copyStatus.hidden = true;
    elements.copy.textContent = "Copied!";
    global.setTimeout(function() { elements.copy.textContent = "Copy link"; }, 1400);
  }

  function attachEvents() {
    ["keydown", "keyup", "keypress"].forEach(function(type) {
      elements.dialog.addEventListener(type, containDialogKeyboardEvent);
      elements.playerSidebar.addEventListener(type, containDialogKeyboardEvent);
    });
    attachPickerEvents(elements.mapOptions, "halo-map-choice", elements.map);
    attachPickerEvents(
      elements.modeOptions,
      "halo-mode-choice",
      elements.mode,
      resetAdvancedDefaultsForMode);
    if (elements.advancedEnabled) {
      elements.advancedEnabled.addEventListener("change", function() {
        syncAdvancedSettingsState(false);
      });
    }
    elements.button.addEventListener("click", function() {
      if (session.active && session.role === "host" && session.hostWasReady) {
        showInvite();
        if (elements.inviteLink) elements.inviteLink.focus();
        return;
      }
      showDialog();
      if (!session.active && session.pendingInvite) showJoinConfirmation(session.pendingInvite);
      else if (!session.active) showSetup();
      else showProgress();
    });
    elements.close.addEventListener("click", function() {
      session.joinRequested = false;
      elements.dialog.close();
    });
    elements.dialog.addEventListener("cancel", function(event) {
      event.preventDefault();
      session.joinRequested = false;
      elements.dialog.close();
    });
    elements.hostForm.addEventListener("submit", function(event) {
      event.preventDefault();
      if (session.wizardStep === "map" && elements.stepMap) {
        try {
          validatedIndex(elements.map.value, LAST_MAP_INDEX, elements.map, "map");
          setWizardStep("mode");
          setStatus("");
        } catch (error) {
          setStatus(error.message, "error");
        }
        return;
      }
      try {
        host(undefined, consumeTurnstile("create_room")).catch(fail);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    if (elements.mapNext) {
      elements.mapNext.addEventListener("click", function() {
        try {
          validatedIndex(elements.map.value, LAST_MAP_INDEX, elements.map, "map");
          setWizardStep("mode");
          setStatus("");
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
    }
    if (elements.modeBack) {
      elements.modeBack.addEventListener("click", function() {
        setWizardStep("map");
        setStatus("");
      });
    }
    elements.joinForm.addEventListener("submit", function(event) {
      event.preventDefault();
      try {
        var invite = parseInvite(elements.code.value);
        showDialog();
        showJoinConfirmation(invite.code);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    if (elements.joinProfile) {
      elements.joinProfile.addEventListener("click", function() {
        requestJoinFromProfile();
      });
    }
    if (elements.verificationRetry) {
      elements.verificationRetry.addEventListener("click", function() {
        var action = elements.dialog && elements.dialog.dataset.view === "join" ?
          "join_room" : "create_room";
        setStatus("");
        renderTurnstile(action, true);
      });
    }
    var updateProfilePreview = function() {
      try {
        var profile = readPlayerProfile();
        session.profile = profile;
        renderPlayerProfilePreview(profile);
        try {
          global.localStorage.setItem(PLAYER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
        } catch (error) { /* Persistence is optional. */ }
      } catch (error) {
        if (elements.profilePreviewName && elements.playerName) {
          elements.profilePreviewName.textContent = elements.playerName.value || "Player";
        }
      }
    };
    if (elements.playerName) elements.playerName.addEventListener("input", updateProfilePreview);
    if (elements.styleOptions) elements.styleOptions.addEventListener("change", updateProfilePreview);
    elements.copy.addEventListener("click", function() {
      copyInvite().catch(function() {
        elements.inviteLink.focus();
        elements.inviteLink.select();
        if (elements.copyStatus) {
          elements.copyStatus.textContent = "Link selected — press ⌘/Ctrl+C to copy.";
          elements.copyStatus.hidden = false;
        }
      });
    });
    elements.leaveHost.addEventListener("click", function() { leave(true).catch(fail); });
    elements.cancel.addEventListener("click", function() { leave(true).catch(fail); });
  }

  function initialize() {
    collectElements();
    restoreHostSettings();
    restorePlayerProfile();
    attachEvents();
    renderRoster();
    setBusy(false);
    startPresencePolling();
    session.pendingInvite = takeInviteFromLocation();
    if (session.pendingInvite) {
      showDialog();
      showJoinConfirmation(session.pendingInvite);
    }
  }

  global.HaloOnline = Object.freeze({
    runtimeReady: function() {
      session.runtimeReady = true;
      setBusy(false);
      try {
        transport();
      } catch (error) {
        fail(error);
        return;
      }
      if (session.pendingInvite) {
        showJoinConfirmation(session.pendingInvite);
        maybeStartRequestedJoin();
      }
    },
    host: host,
    join: join,
    leave: function() { return leave(true); },
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})(typeof window !== "undefined" ? window : null);
