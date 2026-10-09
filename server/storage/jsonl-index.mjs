// H5: in-memory "key → byte range of the latest row" index over an append-only
// JSONL file.
//
// getSavedRoutebook / getSavedProfile used to reverse-scan the whole file on every
// request (unbounded for unknown ids). The index is built once with a streaming
// forward pass, then caught up incrementally from the last indexed byte whenever
// the file grows — including rows appended by other processes. A shrinking file
// or a new inode (rotation/replacement) triggers a rebuild. Lookups read exactly
// one row from disk, so memory stays O(number of keys).
import { open, stat } from 'node:fs/promises';
import { usesPostgresStorage, getPostgresStorage } from './runtime.mjs';
import { eventStreamNameForPath } from './contract.mjs';
import { entityKeyFunctionForStream } from './entityKeys.mjs';

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1024 * 1024;

/**
 * @template T
 * @param {{ filePath: string, keyFn: (row: any) => string | null | undefined }} options
 */
export function createJsonlKeyIndex({ filePath, keyFn }) {
  /** @type {{ ino: number, indexedBytes: number, readBytes: number, offsets: Map<string, { offset: number, length: number }> } | null} */
  let state = null;
  /** @type {Promise<void> | null} */
  let syncing = null;
  let revision = 0;

  async function syncOnce() {
    const startedRevision = revision;
    let handle;
    try {
      handle = await open(filePath, 'r');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (revision === startedRevision) state = null;
      return;
    }
    try {
      // Bind offsets to the opened inode, not a path stat that can race rename.
      // Accumulate changes locally so another reader/reset cannot invalidate an
      // in-progress build or observe its partially populated index.
      const stats = await handle.stat();
      const previous = state?.ino === stats.ino && stats.size >= state.indexedBytes ? state : null;
      const targetSize = stats.size;
      const updates = new Map();
      let position = previous?.indexedBytes ?? 0;
      let pending = Buffer.alloc(0);
      let pendingStart = position;
      while (position < targetSize) {
        const length = Math.min(CHUNK_BYTES, targetSize - position);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const data = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let lineStart = 0;
        for (let index = data.indexOf(NEWLINE); index !== -1; index = data.indexOf(NEWLINE, lineStart)) {
          indexLine(updates, data, lineStart, index, pendingStart + lineStart);
          lineStart = index + 1;
        }
        pendingStart += lineStart;
        pending = data.subarray(lineStart);
      }
      // Only complete (newline-terminated) rows are indexed; a partially written
      // tail is re-read on the next sync.
      const current = await stat(filePath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (revision !== startedRevision || !current || current.ino !== stats.ino || current.size < targetSize) return;
      const offsets = previous?.offsets ?? new Map();
      for (const [key, entry] of updates) offsets.set(key, entry);
      state = { ino: stats.ino, indexedBytes: pendingStart, readBytes: targetSize, offsets };
    } finally {
      await handle.close();
    }
  }

  function indexLine(offsets, buffer, start, end, absoluteOffset) {
    const text = buffer.subarray(start, end).toString('utf8').trim();
    if (!text) return;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      return; // corrupted historical row: same as the reverse scanners, skip it
    }
    const key = keyFn(row);
    if (key) offsets.set(String(key), { offset: absoluteOffset, length: end - start });
  }

  /** Brings the index up to at least the file size observed when called. */
  async function ensureSynced() {
    // A sync that started before our caller's append may finish short of the new
    // size or index the pre-rewrite inode. Recheck the path after every wait.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let stats;
      try {
        stats = await stat(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = null;
        return false;
      }
      if (state?.ino === stats.ino && stats.size >= state.indexedBytes && state.readBytes >= stats.size) return true;
      syncing ??= syncOnce().finally(() => {
        syncing = null;
      });
      await syncing;
    }
    return false;
  }

  return {
    /**
     * Latest row for `key`, or null.
     * @param {string} key
     */
    async get(key) {
      if (!key) return null;
      if (usesPostgresStorage()) {
        const stream = eventStreamNameForPath(filePath);
        const storage = getPostgresStorage();
        // Index-backed when this index uses the stream's canonical entity key.
        if (keyFn === entityKeyFunctionForStream(stream)) return storage.findLatestByEntityKey(stream, String(key));
        return storage.findLatestJsonLine(stream, (row) => keyFn(row) === String(key));
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!(await ensureSynced())) return null;
        const snapshot = state;
        const entry = snapshot?.offsets.get(String(key));
        if (!entry) return null;
        const handle = await open(filePath, 'r').catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!handle) return null;
        try {
          const opened = await handle.stat();
          if (opened.ino === snapshot.ino && opened.size >= snapshot.indexedBytes) {
            const buffer = Buffer.alloc(entry.length);
            const { bytesRead } = await handle.read(buffer, 0, entry.length, entry.offset);
            if (bytesRead === entry.length) {
              const row = JSON.parse(buffer.toString('utf8').trim());
              const current = await stat(filePath);
              if (current.ino === opened.ino && current.size >= snapshot.indexedBytes && keyFn(row) === String(key)) return row;
            }
          }
        } catch {
          // The file changed underneath us; rebuild against its current inode.
        } finally {
          await handle.close();
        }
        if (state === snapshot) {
          state = null;
          revision += 1;
        }
      }
      return null;
    },
    /** Forces a full rebuild on the next lookup. */
    reset() {
      state = null;
      revision += 1;
    },
    stats() {
      return { keys: state?.offsets.size ?? 0, indexedBytes: state?.indexedBytes ?? 0 };
    }
  };
}
