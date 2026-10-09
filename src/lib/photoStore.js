// F09: pending check-in photos live in IndexedDB (as Blobs) instead of being
// inlined as data URLs in the localStorage queue, which hit the ~5 MB quota.
// Falls back to the old inline behaviour when IndexedDB is unavailable.

const DB_NAME = 'trusted-routebook-photos';
const STORE_NAME = 'checkin-photos';

/** @typedef {{ put: (id: string, value: any) => Promise<void>, get: (id: string) => Promise<any>, delete: (id: string) => Promise<void> }} PhotoBackend */

/** @type {PhotoBackend | null | undefined} */
let backendOverride;

/** Test hook: inject an in-memory backend (or null to simulate "no IndexedDB"). */
export function setPhotoBackendForTests(backend) {
  backendOverride = backend;
}

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function transact(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = run(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

/** @returns {PhotoBackend | null} */
function backend() {
  if (backendOverride !== undefined) return backendOverride;
  if (typeof indexedDB === 'undefined') return null;
  return {
    put: (id, value) => transact('readwrite', (store) => store.put(value, id)).then(() => undefined),
    get: (id) => transact('readonly', (store) => store.get(id)),
    delete: (id) => transact('readwrite', (store) => store.delete(id)).then(() => undefined)
  };
}

export function photoStoreAvailable() {
  return Boolean(backend());
}

async function dataUrlToBlob(dataUrl) {
  if (typeof fetch !== 'function' || typeof Blob === 'undefined') return dataUrl;
  return (await fetch(dataUrl)).blob();
}

async function blobToDataUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value.arrayBuffer !== 'function') return '';
  const bytes = new Uint8Array(await value.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${value.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

/** Store a photo for a queued check-in; resolves false if it could not be stored. */
export async function stashCheckinPhoto(id, dataUrl) {
  const store = backend();
  if (!store || !id || !dataUrl) return false;
  try {
    await store.put(String(id), await dataUrlToBlob(dataUrl));
    return true;
  } catch {
    return false;
  }
}

/** Data URL for a stashed photo, or '' when missing (e.g. site data cleared). */
export async function loadCheckinPhoto(id) {
  const store = backend();
  if (!store || !id) return '';
  try {
    return await blobToDataUrl(await store.get(String(id)));
  } catch {
    return '';
  }
}

export async function deleteCheckinPhoto(id) {
  const store = backend();
  if (!store || !id) return;
  try {
    await store.delete(String(id));
  } catch {
    // Best effort: a leftover blob is only wasted space.
  }
}
