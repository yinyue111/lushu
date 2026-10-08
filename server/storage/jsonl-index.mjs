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

  async function syncOnce() {
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      state = null;
      return;
    }
    if (!state || state.ino !== stats.ino || stats.size < state.indexedBytes) {
      state = { ino: stats.ino, indexedBytes: 0, readBytes: 0, offsets: new Map() };
    }
    const targetSize = stats.size;
    if (state.indexedBytes >= targetSize) {
      state.readBytes = targetSize;
      return;
    }
    const handle = await open(filePath, 'r');
    try {
      let position = state.indexedBytes;
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
          indexLine(data, lineStart, index, pendingStart + lineStart);
          lineStart = index + 1;
        }
        pendingStart += lineStart;
        pending = data.subarray(lineStart);
      }
      // Only complete (newline-terminated) rows are indexed; a partially written
      // tail is re-read on the next sync.
      state.indexedBytes = pendingStart;
      state.readBytes = targetSize;
    } finally {
      await handle.close();
    }
  }

  function indexLine(buffer, start, end, absoluteOffset) {
    const text = buffer.subarray(start, end).toString('utf8').trim();
    if (!text) return;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      return; // corrupted historical row: same as the reverse scanners, skip it
    }
    const key = keyFn(row);
    if (key) state?.offsets.set(String(key), { offset: absoluteOffset, length: end - start });
  }

  /** Brings the index up to at least the file size observed when called. */
  async function ensureSynced() {
    let targetSize = 0;
    try {
      targetSize = (await stat(filePath)).size;
    } catch {
      state = null;
      return;
    }
    // A sync that started before our caller's append may finish short of the new
    // size; loop so callers always read their own writes.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (state && state.readBytes >= targetSize) return;
      syncing ??= syncOnce().finally(() => {
        syncing = null;
      });
      await syncing;
      if (!state) return;
    }
  }

  return {
    /**
     * Latest row for `key`, or null.
     * @param {string} key
     */
    async get(key) {
      if (!key) return null;
      await ensureSynced();
      const entry = state?.offsets.get(String(key));
      if (!entry) return null;
      const handle = await open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(entry.length);
        await handle.read(buffer, 0, entry.length, entry.offset);
        const row = JSON.parse(buffer.toString('utf8').trim());
        if (keyFn(row) === String(key)) return row;
      } catch {
        // fall through to rebuild
      } finally {
        await handle.close();
      }
      // The file changed underneath us in a way the size/inode check missed.
      state = null;
      await ensureSynced();
      const retry = state?.offsets.get(String(key));
      if (!retry) return null;
      const again = await open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(retry.length);
        await again.read(buffer, 0, retry.length, retry.offset);
        const row = JSON.parse(buffer.toString('utf8').trim());
        return keyFn(row) === String(key) ? row : null;
      } catch {
        return null;
      } finally {
        await again.close();
      }
    },
    /** Forces a full rebuild on the next lookup. */
    reset() {
      state = null;
    },
    stats() {
      return { keys: state?.offsets.size ?? 0, indexedBytes: state?.indexedBytes ?? 0 };
    }
  };
}
