import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDocumentNameForPath } from './contract.mjs';
import { usesPostgresStorage, getPostgresStorage, withStorageEntityLock } from './runtime.mjs';

export async function readConfigDocument(filePath) {
  if (usesPostgresStorage()) return (await getPostgresStorage().readConfigDocument(configDocumentNameForPath(filePath)))?.document ?? null;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeConfigDocument(filePath, document) {
  if (usesPostgresStorage()) return getPostgresStorage().writeConfigDocument(configDocumentNameForPath(filePath), document);
  return withStorageEntityLock('config', filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return { document };
  });
}
