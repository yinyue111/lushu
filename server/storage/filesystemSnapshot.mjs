import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_DOCUMENTS, EVENT_STREAMS } from './contract.mjs';
import { normalizeJsonObject, sha256 } from './jsonCanonical.mjs';
import { assertRoutebookSnapshotCredentialsSanitized, sanitizeRoutebookSnapshotCredentials } from './routebookCredentials.mjs';
import { buildStorageSnapshot } from './snapshot.mjs';

export async function loadFilesystemStorageSnapshot(dataDir, credentialOptions = {}) {
  const root = resolve(dataDir);
  const streams = {};
  const configs = {};

  await Promise.all(
    EVENT_STREAMS.map(async (definition) => {
      const filePath = join(root, definition.fileName);
      const raw = await readOptionalFile(filePath);
      if (raw === null) {
        streams[definition.name] = { present: false, rows: [] };
        return;
      }
      const rows = [];
      const lines = raw.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          const wrapped = /** @type {Error & {code?: string}} */ (new Error(`${definition.fileName}:${index + 1} is not valid JSON: ${error.message}`));
          wrapped.code = 'INVALID_JSONL_INPUT';
          throw wrapped;
        }
        const normalized = normalizeJsonObject(parsed, `${definition.fileName}:${index + 1}`);
        rows.push(definition.name === 'routebooks' ? sanitizeRoutebookSnapshotCredentials(normalized, credentialOptions) : normalized);
      }
      streams[definition.name] = {
        present: true,
        rows,
        rawSha256: sha256(raw)
      };
    })
  );

  await Promise.all(
    CONFIG_DOCUMENTS.map(async (definition) => {
      const filePath = join(root, definition.fileName);
      const raw = await readOptionalFile(filePath);
      if (raw === null) {
        configs[definition.name] = { present: false };
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const wrapped = /** @type {Error & {code?: string}} */ (new Error(`${definition.fileName} is not valid JSON: ${error.message}`));
        wrapped.code = 'INVALID_CONFIG_INPUT';
        throw wrapped;
      }
      configs[definition.name] = {
        present: true,
        document: normalizeJsonObject(parsed, definition.fileName),
        rawSha256: sha256(raw)
      };
    })
  );

  return buildStorageSnapshot({ streams, configs, source: `filesystem:${root}` });
}

/** @param {any} snapshot @param {string} outputDir @param {{force?: boolean, profileIdSecret?: string, env?: NodeJS.ProcessEnv}} [options] */
export async function exportStorageSnapshotToJsonl(snapshot, outputDir, { force = false, ...credentialOptions } = {}) {
  const exportSnapshot = sanitizeStorageSnapshotRoutebookCredentials(snapshot, credentialOptions);
  const target = resolve(outputDir);
  const targetInfo = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (targetInfo?.isSymbolicLink() || (targetInfo && !targetInfo.isDirectory())) {
    throw new Error(`Export target must be a directory, not a file or symlink: ${target}`);
  }
  const existingEntries = targetInfo ? await readdir(target) : [];
  if (existingEntries.length && !force) {
    const error = /** @type {Error & Record<string, any>} */ (new Error(`Export target is not empty: ${target}. Use --force to replace it.`));
    error.code = 'EXPORT_TARGET_NOT_EMPTY';
    throw error;
  }

  const parent = dirname(target);
  const staging = join(parent, `.${basename(target)}.postgres-export-${process.pid}-${Date.now().toString(36)}`);
  const displaced = join(parent, `.${basename(target)}.postgres-previous-${process.pid}-${Date.now().toString(36)}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await chmod(staging, 0o700);

  try {
    for (const definition of EVENT_STREAMS) {
      const rows = exportSnapshot.streams[definition.name]?.rows ?? [];
      const contents = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
      const filePath = join(staging, definition.fileName);
      await writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(filePath, 0o600);
    }
    for (const definition of CONFIG_DOCUMENTS) {
      const entry = exportSnapshot.configs[definition.name];
      if (!entry?.present) continue;
      const filePath = join(staging, definition.fileName);
      await writeFile(filePath, `${JSON.stringify(entry.document, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      await chmod(filePath, 0o600);
    }

    if (targetInfo) await rename(target, displaced);
    await rename(staging, target);
    await chmod(target, 0o700);
    if (targetInfo) await rm(displaced, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    const currentTarget = await lstat(target).catch(() => null);
    const previousTarget = await lstat(displaced).catch(() => null);
    if (!currentTarget && previousTarget) await rename(displaced, target).catch(() => {});
    throw error;
  }

  return {
    outputDir: target,
    eventStreamFiles: EVENT_STREAMS.length,
    configFiles: CONFIG_DOCUMENTS.filter(({ name }) => exportSnapshot.configs[name]?.present).length,
    manifestSha256: exportSnapshot.manifestSha256
  };
}

export function sanitizeStorageSnapshotRoutebookCredentials(snapshot, credentialOptions = {}) {
  const routebookRows = snapshot?.streams?.routebooks?.rows;
  if (!Array.isArray(routebookRows)) {
    const error = /** @type {Error & Record<string, any>} */ (new Error('Storage snapshot is missing the routebooks stream.'));
    error.code = 'INVALID_STORAGE_SNAPSHOT';
    throw error;
  }
  const sanitizedRows = routebookRows.map((row) =>
    sanitizeRoutebookSnapshotCredentials(normalizeJsonObject(row, 'routebooks snapshot row'), credentialOptions)
  );
  sanitizedRows.forEach((row) => assertRoutebookSnapshotCredentialsSanitized(row));
  return buildStorageSnapshot({
    source: snapshot.source,
    streams: {
      ...snapshot.streams,
      routebooks: {
        ...snapshot.streams.routebooks,
        rows: sanitizedRows
      }
    },
    configs: snapshot.configs
  });
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
