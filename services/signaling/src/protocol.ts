export const SIGNALING_PROTOCOL_VERSION = 1 as const;
export const MAX_HTTP_BODY_BYTES = 4_096;
export const MAX_WEBSOCKET_MESSAGE_CHARACTERS = 65_536;

export const ROOM_ID_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}_[A-Za-z0-9_-]{43}$/u;
export const PEER_ID_PATTERN = /^[hg]_[A-Za-z0-9_-]{16}$/u;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/u;
export const IDENTIFIER_PATTERN = /^[0-9a-f]{12}$/u;
const BUILD_ID_PATTERN = /^[A-Za-z0-9._:+-]{1,96}$/u;

export const PLAYER_STYLES = [
  "white",
  "black",
  "red",
  "blue",
  "sage",
  "yellow",
  "lime",
  "pink",
  "purple",
  "cyan",
  "cornflower",
  "orange",
  "teal",
  "forest",
  "brown",
  "tan",
  "maroon",
  "rose",
] as const;

export type PlayerStyle = (typeof PLAYER_STYLES)[number];

export const MULTIPLAYER_MAPS = [
  "Battle Creek",
  "Sidewinder",
  "Damnation",
  "Rat Race",
  "Prisoner",
  "Hang 'Em High",
  "Chill Out",
  "Derelict",
  "Boarding Action",
  "Blood Gulch",
  "Wizard",
  "Chiron TL-34",
  "Longest",
] as const;

export const MULTIPLAYER_MODES = [
  "Slayer",
  "Team Slayer",
  "Capture the Flag",
  "Oddball",
  "King of the Hill",
  "Race",
] as const;

export type MultiplayerMap = (typeof MULTIPLAYER_MAPS)[number];
export type MultiplayerMode = (typeof MULTIPLAYER_MODES)[number];

export interface PlayerProfile {
  name: string;
  style: PlayerStyle;
}

export type PeerRole = "host" | "guest";

export interface CreateRoomInput {
  buildId: string;
  capacity?: number;
  identifier: string;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
  turnstileToken?: string;
}

export interface CreateSessionInput {
  buildId: string;
  identifier: string;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
  ticket: string;
  turnstileToken?: string;
}

export interface SessionDescriptor {
  identifier: string;
  peerId: string;
  role: PeerRole;
  token: string;
  websocketUrl: string;
}

export interface IceServerDescriptor {
  credential?: string;
  credentialType?: "password";
  urls: string[];
  username?: string;
}

export interface PublicRoomDescriptor {
  buildId: string;
  capacity: number;
  expiresAt: number;
  id: string;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
}

export type MatchPhase = "lobby" | "live";

export interface ListedGame {
  buildId: string;
  capacity: number;
  country: string | null;
  hostName: string;
  joinCode: string;
  map: MultiplayerMap;
  mode: MultiplayerMode;
  name: string;
  open: boolean;
  phase: MatchPhase;
  players: number;
  queue: number;
  roomId: string;
}

export interface CreateRoomResponse {
  host: {
    session: SessionDescriptor;
    ticket: string;
  };
  invite: {
    code: string;
    url: string;
  };
  iceServers: IceServerDescriptor[];
  iceServersExpiresAt: number | null;
  room: PublicRoomDescriptor;
  v: typeof SIGNALING_PROTOCOL_VERSION;
}

export interface CreateSessionResponse {
  iceServers: IceServerDescriptor[];
  iceServersExpiresAt: number | null;
  room: PublicRoomDescriptor;
  session: SessionDescriptor;
  v: typeof SIGNALING_PROTOCOL_VERSION;
}

export type SessionDescriptionSignal = {
  description: {
    sdp: string;
    type: "answer" | "offer";
  };
  kind: "description";
};

export type IceCandidateSignal = {
  candidate:
    | {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
        usernameFragment?: string | null;
      }
    | null;
  kind: "candidate";
};

export type WebRtcSignal = IceCandidateSignal | SessionDescriptionSignal;

export type ClientMessage =
  | {
      nonce?: string;
      type: "ping";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      profile: PlayerProfile;
      type: "profile";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      listed: false;
      type: "listing";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      listed: true;
      map: MultiplayerMap;
      mode: MultiplayerMode;
      name: string;
      ticket: string;
      type: "listing";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      phase: MatchPhase;
      type: "phase";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      signal: WebRtcSignal;
      to: string;
      type: "signal";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    };

type ValidationResult<T> =
  | { ok: true; value: T }
  | { message: string; ok: false };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolVersion(
  value: unknown,
): value is typeof SIGNALING_PROTOCOL_VERSION {
  return value === SIGNALING_PROTOCOL_VERSION;
}

function isPlayerStyle(value: unknown): value is PlayerStyle {
  return (
    typeof value === "string" &&
    (PLAYER_STYLES as readonly string[]).includes(value)
  );
}

export function parsePlayerProfile(
  value: unknown,
): ValidationResult<PlayerProfile> {
  if (!isRecord(value)) {
    return { ok: false, message: "Player profile must be an object." };
  }

  const { name, style } = value;
  if (
    typeof name !== "string" ||
    name !== name.trim() ||
    name.length < 1 ||
    name.length > 11 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/u.test(name)
  ) {
    return {
      ok: false,
      message:
        "Player name must be 1-11 basic letters, numbers, spaces, or simple punctuation.",
    };
  }
  if (!isPlayerStyle(style)) {
    return { ok: false, message: "Player style is invalid." };
  }

  return { ok: true, value: { name, style } };
}

function isBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_PATTERN.test(value);
}

export function parseBuildId(value: unknown): string | null {
  return isBuildId(value) ? value : null;
}

export function isMultiplayerMap(value: unknown): value is MultiplayerMap {
  return (
    typeof value === "string" &&
    (MULTIPLAYER_MAPS as readonly string[]).includes(value)
  );
}

export function isMultiplayerMode(value: unknown): value is MultiplayerMode {
  return (
    typeof value === "string" &&
    (MULTIPLAYER_MODES as readonly string[]).includes(value)
  );
}

export function parseServerName(value: unknown): ValidationResult<string> {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 40 ||
    value !== value.trim() ||
    !/^[\u0020-\u007E]+$/u.test(value) ||
    !/[A-Za-z0-9]/u.test(value)
  ) {
    return {
      ok: false,
      message:
        "Server name must be 1-40 letters, numbers, spaces, or basic punctuation.",
    };
  }
  return { ok: true, value };
}

export function parseCountryCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{2}$/u.test(value) ? value : null;
}

export function parseMatchPhase(value: unknown): MatchPhase | null {
  return value === "lobby" || value === "live" ? value : null;
}

function turnstileToken(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 ? value : null;
}

export function parseCreateRoomInput(
  value: unknown,
): ValidationResult<CreateRoomInput> {
  if (!isRecord(value)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  if (!isProtocolVersion(value.protocolVersion)) {
    return { ok: false, message: "Unsupported protocolVersion." };
  }
  if (!isBuildId(value.buildId)) {
    return {
      ok: false,
      message: "buildId must be 1-96 URL-safe characters.",
    };
  }
  if (
    typeof value.identifier !== "string" ||
    !IDENTIFIER_PATTERN.test(value.identifier)
  ) {
    return {
      ok: false,
      message: "identifier must be exactly 12 lowercase hexadecimal characters.",
    };
  }
  const verifiedToken = turnstileToken(value.turnstileToken);
  if (verifiedToken === null) return { ok: false, message: "turnstileToken is malformed." };
  if (
    value.capacity !== undefined &&
    (!Number.isInteger(value.capacity) ||
      typeof value.capacity !== "number" ||
      value.capacity < 2)
  ) {
    return { ok: false, message: "capacity must be an integer of at least 2." };
  }

  return {
    ok: true,
    value: {
      buildId: value.buildId,
      ...(value.capacity === undefined ? {} : { capacity: value.capacity }),
      identifier: value.identifier,
      protocolVersion: value.protocolVersion,
      ...(verifiedToken === undefined ? {} : { turnstileToken: verifiedToken }),
    },
  };
}

export function parseCreateSessionInput(
  value: unknown,
): ValidationResult<CreateSessionInput> {
  if (!isRecord(value)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  if (!isProtocolVersion(value.protocolVersion)) {
    return { ok: false, message: "Unsupported protocolVersion." };
  }
  if (!isBuildId(value.buildId)) {
    return {
      ok: false,
      message: "buildId must be 1-96 URL-safe characters.",
    };
  }
  if (
    typeof value.identifier !== "string" ||
    !IDENTIFIER_PATTERN.test(value.identifier)
  ) {
    return {
      ok: false,
      message: "identifier must be exactly 12 lowercase hexadecimal characters.",
    };
  }
  if (typeof value.ticket !== "string" || !TOKEN_PATTERN.test(value.ticket)) {
    return { ok: false, message: "ticket is malformed." };
  }
  const verifiedToken = turnstileToken(value.turnstileToken);
  if (verifiedToken === null) return { ok: false, message: "turnstileToken is malformed." };

  return {
    ok: true,
    value: {
      buildId: value.buildId,
      identifier: value.identifier,
      protocolVersion: value.protocolVersion,
      ticket: value.ticket,
      ...(verifiedToken === undefined ? {} : { turnstileToken: verifiedToken }),
    },
  };
}

function parseDescriptionSignal(value: Record<string, unknown>): WebRtcSignal | null {
  if (value.kind !== "description" || !isRecord(value.description)) {
    return null;
  }
  const { sdp, type } = value.description;
  if (
    (type !== "offer" && type !== "answer") ||
    typeof sdp !== "string" ||
    !/^v=0(?:\r\n|\n)/u.test(sdp) ||
    sdp.length > 32_768
  ) {
    return null;
  }
  return { description: { sdp, type }, kind: "description" };
}

function nullableShortString(
  value: unknown,
  maximumLength: number,
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= maximumLength)
  );
}

function parseCandidateSignal(value: Record<string, unknown>): WebRtcSignal | null {
  if (value.kind !== "candidate") {
    return null;
  }
  if (value.candidate === null) {
    return { candidate: null, kind: "candidate" };
  }
  if (!isRecord(value.candidate)) {
    return null;
  }

  const candidate = value.candidate;
  if (
    typeof candidate.candidate !== "string" ||
    candidate.candidate.length > 4_096 ||
    !nullableShortString(candidate.sdpMid, 256) ||
    !(
      candidate.sdpMLineIndex === null ||
      (typeof candidate.sdpMLineIndex === "number" &&
        Number.isInteger(candidate.sdpMLineIndex) &&
        candidate.sdpMLineIndex >= 0 &&
        candidate.sdpMLineIndex <= 65_535)
    ) ||
    (candidate.usernameFragment !== undefined &&
      !nullableShortString(candidate.usernameFragment, 256))
  ) {
    return null;
  }

  return {
    candidate: {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      ...(candidate.usernameFragment === undefined
        ? {}
        : { usernameFragment: candidate.usernameFragment }),
    },
    kind: "candidate",
  };
}

export function parseClientMessage(value: unknown): ValidationResult<ClientMessage> {
  if (!isRecord(value) || !isProtocolVersion(value.v)) {
    return { ok: false, message: "Invalid signaling envelope." };
  }

  if (value.type === "ping") {
    if (
      value.nonce !== undefined &&
      (typeof value.nonce !== "string" || value.nonce.length > 64)
    ) {
      return { ok: false, message: "Ping nonce is invalid." };
    }
    return {
      ok: true,
      value: {
        ...(value.nonce === undefined ? {} : { nonce: value.nonce }),
        type: "ping",
        v: SIGNALING_PROTOCOL_VERSION,
      },
    };
  }

  if (value.type === "profile") {
    const profile = parsePlayerProfile(value.profile);
    if (!profile.ok) {
      return profile;
    }
    return {
      ok: true,
      value: {
        profile: profile.value,
        type: "profile",
        v: SIGNALING_PROTOCOL_VERSION,
      },
    };
  }

  if (value.type === "listing") {
    if (value.listed === false) {
      return {
        ok: true,
        value: { listed: false, type: "listing", v: SIGNALING_PROTOCOL_VERSION },
      };
    }
    if (value.listed !== true) {
      return { ok: false, message: "Listing must say whether the game is public." };
    }
    const name = parseServerName(value.name);
    if (!name.ok) return name;
    if (!isMultiplayerMap(value.map) || !isMultiplayerMode(value.mode)) {
      return { ok: false, message: "Listing map or mode is invalid." };
    }
    if (typeof value.ticket !== "string" || !TOKEN_PATTERN.test(value.ticket)) {
      return { ok: false, message: "Listing ticket is malformed." };
    }
    return {
      ok: true,
      value: {
        listed: true,
        map: value.map,
        mode: value.mode,
        name: name.value,
        ticket: value.ticket,
        type: "listing",
        v: SIGNALING_PROTOCOL_VERSION,
      },
    };
  }

  if (value.type === "phase") {
    const phase = parseMatchPhase(value.phase);
    if (phase === null) {
      return { ok: false, message: "Match phase must be lobby or live." };
    }
    return {
      ok: true,
      value: { phase, type: "phase", v: SIGNALING_PROTOCOL_VERSION },
    };
  }

  if (
    value.type !== "signal" ||
    typeof value.to !== "string" ||
    !PEER_ID_PATTERN.test(value.to) ||
    !isRecord(value.signal)
  ) {
    return { ok: false, message: "Invalid signal message." };
  }

  const signal =
    parseDescriptionSignal(value.signal) ?? parseCandidateSignal(value.signal);
  if (signal === null) {
    return { ok: false, message: "Invalid WebRTC signal payload." };
  }

  return {
    ok: true,
    value: {
      signal,
      to: value.to,
      type: "signal",
      v: SIGNALING_PROTOCOL_VERSION,
    },
  };
}
