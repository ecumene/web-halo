/* Read the Halo Xbox XDVDFS image locally and expose its maps to FetchFS.
 *
 * This module is included as Emscripten pre-JavaScript, so it runs in both the
 * browser window and game workers. The window installs validated map extents
 * into OPFS once; workers then answer FetchFS HEAD and byte-range requests from
 * that local cache without loading a whole map (or disc image) into memory.
 */
;(function installHaloXiso(global) {
  "use strict";

  if (!global || global.HaloXiso) return;

  const SECTOR_SIZE = 2048;
  const VOLUME_DESCRIPTOR_OFFSET = 0x10000;
  const ENTRY_HEADER_SIZE = 14;
  const ATTRIBUTE_DIRECTORY = 0x10;
  const MAXIMUM_DIRECTORY_SIZE = 4 << 20;
  const MAXIMUM_ENTRIES = 256;
  const MAXIMUM_VISITED_NODES = 4096;
  const COPY_CHUNK_SIZE = 4 << 20;
  const VOLUME_MAGIC = "MICROSOFT*XBOX*MEDIA";
  const PARTITION_OFFSETS = Object.freeze([0, 0x0fd90000, 0x02080000, 0x18300000]);
  const INSTALL_DIRECTORY = "halo-xiso-v1";
  const MAPS_DIRECTORY = "maps";
  const MANIFEST_FILE = "manifest.json";
  const INSTALL_VERSION = 1;
  const REQUIRED_MAPS = Object.freeze([
    "a10.map", "a30.map", "a50.map", "b30.map", "b40.map", "c10.map",
    "c20.map", "c40.map", "d20.map", "d40.map", "beavercreek.map",
    "bloodgulch.map", "boardingaction.map", "carousel.map", "chillout.map",
    "damnation.map", "hangemhigh.map", "longest.map", "prisoner.map",
    "putput.map", "ratrace.map", "sidewinder.map", "ui.map", "wizard.map",
  ]);
  const REQUIRED_MAP_SET = new Set(REQUIRED_MAPS);
  let manifestPromise = null;

  class XisoError extends Error {
    constructor(message) {
      super(message);
      this.name = "XisoError";
    }
  }

  function u16(bytes, offset) {
    return bytes[offset] | bytes[offset + 1] << 8;
  }

  function u32(bytes, offset) {
    return (bytes[offset] | bytes[offset + 1] << 8 |
      bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
  }

  function hasMagic(bytes, offset) {
    if (offset < 0 || offset + VOLUME_MAGIC.length > bytes.length) return false;
    for (let index = 0; index < VOLUME_MAGIC.length; index++) {
      if (bytes[offset + index] !== VOLUME_MAGIC.charCodeAt(index)) return false;
    }
    return true;
  }

  async function readAt(image, offset, size, description) {
    if (!image || typeof image.slice !== "function" || !Number.isSafeInteger(image.size)) {
      throw new XisoError("Choose a local XISO file to continue.");
    }
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) ||
        offset < 0 || size < 0 || offset + size > image.size) {
      throw new XisoError(`${description} lies outside the disc image; the file may be incomplete.`);
    }
    const bytes = new Uint8Array(await image.slice(offset, offset + size).arrayBuffer());
    if (bytes.byteLength !== size) {
      throw new XisoError(`Could not read ${description}; wait for the XISO to finish copying.`);
    }
    return bytes;
  }

  function extentOffset(imageSize, partition, sector, size, description) {
    const offset = partition + sector * SECTOR_SIZE;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) ||
        sector < 0 || size < 0 || offset + size > imageSize) {
      throw new XisoError(`${description} points outside the disc image.`);
    }
    return offset;
  }

  async function findVolume(image) {
    for (const partition of PARTITION_OFFSETS) {
      const descriptorOffset = partition + VOLUME_DESCRIPTOR_OFFSET;
      if (descriptorOffset + SECTOR_SIZE > image.size) continue;
      const descriptor = await readAt(
        image, descriptorOffset, SECTOR_SIZE, "an XDVDFS volume descriptor");
      if (hasMagic(descriptor, 0) && hasMagic(descriptor, 0x7ec)) {
        return {
          partition,
          rootSector: u32(descriptor, 20),
          rootSize: u32(descriptor, 24),
        };
      }
    }
    throw new XisoError("This is not a supported XDVDFS disc image.");
  }

  async function readDirectory(image, partition, sector, size, description) {
    if (size <= 0 || size > MAXIMUM_DIRECTORY_SIZE) {
      throw new XisoError(`${description} has an invalid directory size (${size} bytes).`);
    }
    return readAt(
      image,
      extentOffset(image.size, partition, sector, size, description),
      size,
      description,
    );
  }

  function walkDirectory(table, wantDirectories) {
    const entries = [];
    const visited = new Set();

    function walk(pointer, depth) {
      const offset = pointer * 4;
      if (depth > 64) throw new XisoError("An XDVDFS directory tree is nested too deeply.");
      if (visited.size >= MAXIMUM_VISITED_NODES) {
        throw new XisoError("An XDVDFS directory tree has too many nodes.");
      }
      if (visited.has(offset)) throw new XisoError("An XDVDFS directory tree contains a cycle.");
      if (offset < 0 || offset + ENTRY_HEADER_SIZE > table.length) {
        throw new XisoError("An XDVDFS directory entry points outside its table.");
      }

      visited.add(offset);
      const left = u16(table, offset);
      const right = u16(table, offset + 2);
      if (left === 0xffff) return;

      const nameLength = table[offset + 13];
      const nameEnd = offset + ENTRY_HEADER_SIZE + nameLength;
      if (!nameLength || nameEnd > table.length) {
        throw new XisoError("An XDVDFS directory entry has an invalid name.");
      }
      if (left) walk(left, depth + 1);

      let name = "";
      for (let index = offset + ENTRY_HEADER_SIZE; index < nameEnd; index++) {
        const value = table[index];
        if (value > 0x7f) throw new XisoError("An XDVDFS filename is not ASCII.");
        name += String.fromCharCode(value);
      }
      if (name === "." || name === ".." || /[\\/\0]/u.test(name)) {
        throw new XisoError(`Unsafe filename in the disc image: ${JSON.stringify(name)}.`);
      }

      const isDirectory = Boolean(table[offset + 12] & ATTRIBUTE_DIRECTORY);
      if (isDirectory === wantDirectories) {
        if (entries.length >= MAXIMUM_ENTRIES) {
          throw new XisoError("An XDVDFS directory contains too many entries.");
        }
        entries.push({
          name,
          sector: u32(table, offset + 4),
          size: u32(table, offset + 8),
          isDirectory,
        });
      }
      if (right) walk(right, depth + 1);
    }

    walk(0, 0);
    return entries;
  }

  async function readCatalog(image) {
    const volume = await findVolume(image);
    const root = await readDirectory(
      image, volume.partition, volume.rootSector, volume.rootSize, "the XDVDFS root directory");
    const mapDirectories = walkDirectory(root, true)
      .filter(entry => entry.name.toLowerCase() === "maps");
    if (mapDirectories.length !== 1) {
      throw new XisoError("The disc image does not contain exactly one maps directory.");
    }

    const mapsEntry = mapDirectories[0];
    const maps = await readDirectory(
      image, volume.partition, mapsEntry.sector, mapsEntry.size, "the maps directory");
    const files = walkDirectory(maps, false);
    if (!files.length) throw new XisoError("The maps directory is empty.");

    const byName = new Map();
    for (const entry of files) {
      const name = entry.name.toLowerCase();
      if (byName.has(name)) {
        throw new XisoError(`The maps directory contains a duplicate filename: ${entry.name}.`);
      }
      entry.offset = extentOffset(
        image.size, volume.partition, entry.sector, entry.size, `maps/${entry.name}`);
      byName.set(name, entry);
    }
    if (!byName.has("ui.map")) {
      throw new XisoError("The maps directory has no ui.map; choose a supported game disc.");
    }
    return { partition: volume.partition, files, byName };
  }

  function storageManager() {
    if (!global.navigator || !global.navigator.storage ||
        typeof global.navigator.storage.getDirectory !== "function") {
      throw new XisoError("This browser does not support the private local storage the game needs.");
    }
    return global.navigator.storage;
  }

  async function readManifest() {
    const root = await storageManager().getDirectory();
    const install = await root.getDirectoryHandle(INSTALL_DIRECTORY);
    const handle = await install.getFileHandle(MANIFEST_FILE);
    const file = await handle.getFile();
    const manifest = JSON.parse(await file.text());
    if (!manifest || manifest.version !== INSTALL_VERSION ||
        !manifest.maps || typeof manifest.maps !== "object") {
      throw new XisoError("The local game-data manifest is invalid.");
    }
    return { root, install, manifest };
  }

  async function installedState() {
    try {
      const state = await readManifest();
      const maps = await state.install.getDirectoryHandle(MAPS_DIRECTORY);
      for (const name of REQUIRED_MAPS) {
        const expected = state.manifest.maps[name];
        if (!Number.isSafeInteger(expected) || expected <= 0) return null;
        const file = await (await maps.getFileHandle(name)).getFile();
        if (file.size !== expected) return null;
      }
      return state;
    } catch (_error) {
      return null;
    }
  }

  async function isInstalled() {
    return Boolean(await installedState());
  }

  async function writeJson(directory, name, value) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(JSON.stringify(value));
    await writable.close();
  }

  async function install(image, onProgress) {
    const report = typeof onProgress === "function" ? onProgress : () => {};
    report({ phase: "catalog", message: "Checking the disc image…" });
    const catalog = await readCatalog(image);
    const missing = REQUIRED_MAPS.filter(name => !catalog.byName.has(name));
    if (missing.length) {
      throw new XisoError(`This disc is missing required maps: ${missing.join(", ")}.`);
    }
    const entries = REQUIRED_MAPS.map(name => catalog.byName.get(name));
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const storage = storageManager();
    const root = await storage.getDirectory();
    /* A cancelled first attempt can consume most of the origin quota. Remove
     * only this app-owned incomplete/old cache before measuring free space so
     * the user can retry without clearing site data manually. */
    try { await root.removeEntry(INSTALL_DIRECTORY, { recursive: true }); } catch (_error) {}
    if (typeof storage.estimate === "function") {
      const estimate = await storage.estimate();
      if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) &&
          estimate.quota - estimate.usage < totalBytes + (64 << 20)) {
        throw new XisoError(
          `Not enough browser storage. The game needs about ${formatBytes(totalBytes)} free.`);
      }
    }
    if (typeof storage.persist === "function") {
      try { await storage.persist(); } catch (_error) { /* Best effort only. */ }
    }

    const installDirectory = await root.getDirectoryHandle(INSTALL_DIRECTORY, { create: true });
    const mapsDirectory = await installDirectory.getDirectoryHandle(MAPS_DIRECTORY, { create: true });
    let completedBytes = 0;
    const mapSizes = {};

    try {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const name = entry.name.toLowerCase();
        const handle = await mapsDirectory.getFileHandle(name, { create: true });
        const writable = await handle.createWritable({ keepExistingData: false });
        let position = 0;
        try {
          while (position < entry.size) {
            const length = Math.min(COPY_CHUNK_SIZE, entry.size - position);
            const chunk = await image.slice(
              entry.offset + position, entry.offset + position + length).arrayBuffer();
            if (chunk.byteLength !== length) {
              throw new XisoError(`Could not finish reading maps/${entry.name}.`);
            }
            await writable.write(chunk);
            position += length;
            report({
              phase: "copy",
              name,
              index: index + 1,
              count: entries.length,
              completedBytes: completedBytes + position,
              totalBytes,
            });
          }
          await writable.close();
        } catch (error) {
          try { await writable.abort(); } catch (_abortError) {}
          throw error;
        }
        mapSizes[name] = entry.size;
        completedBytes += entry.size;
      }
      await writeJson(installDirectory, MANIFEST_FILE, {
        version: INSTALL_VERSION,
        installedAt: new Date().toISOString(),
        sourceSize: image.size,
        maps: mapSizes,
      });
      manifestPromise = null;
      report({ phase: "ready", completedBytes: totalBytes, totalBytes });
      return { totalBytes, mapCount: entries.length };
    } catch (error) {
      try { await root.removeEntry(INSTALL_DIRECTORY, { recursive: true }); } catch (_cleanupError) {}
      manifestPromise = null;
      throw error;
    }
  }

  function formatBytes(bytes) {
    let value = Number(bytes) || 0;
    const units = ["B", "KiB", "MiB", "GiB"];
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }

  function unsignedInteger(text) {
    if (!/^\d+$/u.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
  }

  function parseRange(value, size) {
    if (!value) return null;
    const match = /^bytes=(\d*)-(\d*)$/iu.exec(String(value).trim());
    if (!match || (!match[1] && !match[2]) || size <= 0) return false;
    if (!match[1]) {
      const suffix = unsignedInteger(match[2]);
      if (suffix === null || suffix === 0) return false;
      const length = Math.min(suffix, size);
      return { offset: size - length, length };
    }
    const offset = unsignedInteger(match[1]);
    if (offset === null || offset >= size) return false;
    if (!match[2]) return { offset, length: size - offset };
    const requestedEnd = unsignedInteger(match[2]);
    if (requestedEnd === null || requestedEnd < offset) return false;
    const end = Math.min(requestedEnd, size - 1);
    return { offset, length: end - offset + 1 };
  }

  async function installedManifest() {
    if (!manifestPromise) manifestPromise = readManifest().catch(() => null);
    return manifestPromise;
  }

  async function responseForMapRequest(resource, options) {
    const originalUrl = typeof resource === "string" || resource instanceof URL
      ? String(resource)
      : resource && resource.url;
    if (!originalUrl) return null;
    const url = new URL(originalUrl, global.location && global.location.href || "http://localhost/");
    const match = /\/assets\/maps\/{1,}([^/]+)$/iu.exec(url.pathname);
    if (!match) return null;
    let name;
    try { name = decodeURIComponent(match[1]).toLowerCase(); } catch (_error) { return null; }
    if (!REQUIRED_MAP_SET.has(name)) return null;

    const state = await installedManifest();
    if (!state || !Number.isSafeInteger(state.manifest.maps[name])) return null;
    let file;
    try {
      const maps = await state.install.getDirectoryHandle(MAPS_DIRECTORY);
      file = await (await maps.getFileHandle(name)).getFile();
    } catch (_error) {
      manifestPromise = null;
      return null;
    }
    if (file.size !== state.manifest.maps[name]) {
      manifestPromise = null;
      return null;
    }

    const method = String(
      options && options.method || resource instanceof Request && resource.method || "GET"
    ).toUpperCase();
    const requestHeaders = new Headers(
      options && options.headers || resource instanceof Request && resource.headers || undefined);
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Type": "application/octet-stream",
    });
    if (method === "HEAD") {
      headers.set("Content-Length", String(file.size));
      return new Response(null, { status: 200, headers });
    }
    if (method !== "GET") {
      headers.set("Allow", "GET, HEAD");
      return new Response(null, { status: 405, headers });
    }

    const rangeHeader = requestHeaders.get("Range");
    if (rangeHeader !== null) {
      const range = parseRange(rangeHeader, file.size);
      if (!range) {
        headers.set("Content-Range", `bytes */${file.size}`);
        headers.set("Content-Length", "0");
        return new Response(null, { status: 416, headers });
      }
      headers.set("Content-Length", String(range.length));
      headers.set(
        "Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
      return new Response(file.slice(range.offset, range.offset + range.length), {
        status: 206,
        headers,
      });
    }
    headers.set("Content-Length", String(file.size));
    return new Response(file, { status: 200, headers });
  }

  const api = Object.freeze({
    COPY_CHUNK_SIZE,
    REQUIRED_MAPS,
    XisoError,
    formatBytes,
    install,
    isInstalled,
    parseRange,
    readCatalog,
    responseForMapRequest,
  });
  global.HaloXiso = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : self);
