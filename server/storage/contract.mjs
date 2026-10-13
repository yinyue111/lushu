import { basename } from 'node:path';

export const POSTGRES_SCHEMA = 'trusted_routebook';
export const POSTGRES_STORAGE_SCHEMA_VERSION = 12;
// Oldest schema this code still runs on. v11 lacks only the additive 0012 admin tables/columns, so a
// rollback is "swap the image" in both directions (docs/admin.md §6); admin features are off on v11.
export const POSTGRES_STORAGE_MIN_SCHEMA_VERSION = 11;
export const isSupportedSchemaVersion = (v) =>
  Number.isInteger(Number(v)) && Number(v) >= POSTGRES_STORAGE_MIN_SCHEMA_VERSION && Number(v) <= POSTGRES_STORAGE_SCHEMA_VERSION;

export const EVENT_STREAMS = Object.freeze([
  { name: 'ai-logs', fileName: 'ai-logs.jsonl' },
  { name: 'identity-nonces', fileName: 'identity-nonces.jsonl' },
  { name: 'checkins', fileName: 'checkins.jsonl' },
  { name: 'trip-sessions', fileName: 'trip-sessions.jsonl' },
  { name: 'ops-audits', fileName: 'ops-audits.jsonl' },
  { name: 'clicks', fileName: 'clicks.jsonl' },
  { name: 'exposures', fileName: 'exposures.jsonl' },
  { name: 'routebooks', fileName: 'routebooks.jsonl' },
  { name: 'routebook-audits', fileName: 'routebook-audits.jsonl' },
  { name: 'profiles', fileName: 'profiles.jsonl' },
  { name: 'profile-lifecycle', fileName: 'profile-lifecycle.jsonl' },
  { name: 'poi-corrections', fileName: 'poi-corrections.jsonl' },
  { name: 'poi-knowledge', fileName: 'poi-knowledge.jsonl' },
  { name: 'pois', fileName: 'pois.jsonl' },
  { name: 'reviews', fileName: 'reviews.jsonl' },
  { name: 'imports', fileName: 'imports.jsonl' },
  { name: 'favorites', fileName: 'favorites.jsonl' },
  { name: 'checkin-photos', fileName: 'checkin-photos.jsonl' },
  { name: 'poi-merges', fileName: 'poi-merges.jsonl' },
  { name: 'moderation-queue', fileName: 'moderation-queue.jsonl' },
  { name: 'shadow-judgments', fileName: 'shadow-judgments.jsonl' },
  { name: 'funnel-events', fileName: 'funnel-events.jsonl' },
  { name: 'client-errors', fileName: 'client-errors.jsonl' }
]);

export const CONFIG_DOCUMENTS = Object.freeze([
  { name: 'cms-config', fileName: 'cms-config.json' },
  { name: 'product-config', fileName: 'product-config.json' }
]);

const EVENT_STREAM_NAMES = new Set(EVENT_STREAMS.map(({ name }) => name));
const EVENT_STREAM_BY_FILE = new Map(EVENT_STREAMS.map((entry) => [entry.fileName, entry.name]));
const CONFIG_NAMES = new Set(CONFIG_DOCUMENTS.map(({ name }) => name));
const CONFIG_BY_FILE = new Map(CONFIG_DOCUMENTS.map((entry) => [entry.fileName, entry.name]));

export function assertEventStreamName(value) {
  const name = String(value ?? '').trim();
  if (!EVENT_STREAM_NAMES.has(name)) {
    throw storageContractError('UNKNOWN_EVENT_STREAM', `Unknown PostgreSQL event stream: ${name || '(empty)'}`);
  }
  return name;
}

export function assertConfigDocumentName(value) {
  const name = String(value ?? '').trim();
  if (!CONFIG_NAMES.has(name)) {
    throw storageContractError('UNKNOWN_CONFIG_DOCUMENT', `Unknown PostgreSQL config document: ${name || '(empty)'}`);
  }
  return name;
}

export function eventStreamNameForPath(filePath) {
  const name = EVENT_STREAM_BY_FILE.get(basename(String(filePath ?? '')));
  if (!name) {
    throw storageContractError('UNKNOWN_EVENT_STREAM_PATH', `Path is not one of the ${EVENT_STREAMS.length} storage streams: ${filePath}`);
  }
  return name;
}

export function configDocumentNameForPath(filePath) {
  const name = CONFIG_BY_FILE.get(basename(String(filePath ?? '')));
  if (!name) {
    throw storageContractError('UNKNOWN_CONFIG_DOCUMENT_PATH', `Path is not one of the 2 config documents: ${filePath}`);
  }
  return name;
}

export function requirePostgresStorageBackend(value = process.env.STORAGE_BACKEND) {
  const backend = String(value ?? '')
    .trim()
    .toLowerCase();
  if (backend !== 'postgres') {
    throw storageContractError(
      'POSTGRES_STORAGE_REQUIRED',
      'STORAGE_BACKEND must be postgres. JSONL is supported only as migration input and rollback export.'
    );
  }
  return backend;
}

export function storageContractError(code, message) {
  const error = /** @type {Error & Record<string, any>} */ (new Error(message));
  error.code = code;
  return error;
}
