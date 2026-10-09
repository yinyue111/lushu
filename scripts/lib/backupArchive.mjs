import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SOURCE_COORDINATION_DIRECTORY_NAME } from '../../server/storage/sourceCoordination.mjs';

export const BACKUP_APP_ID = 'trusted-routebook';
export const BACKUP_FORMAT_VERSION = 1;
const BACKUP_HEADER = 'TRBK1\n';
const BACKUP_AAD = Buffer.from('trusted-routebook-backup-v1', 'utf8');

export function requireBackupKey(environment = process.env) {
  const value = String(environment.BACKUP_ENCRYPTION_KEY ?? '');
  if (Buffer.byteLength(value, 'utf8') < 16) {
    throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 16 UTF-8 bytes');
  }
  return value;
}

export async function createEncryptedBackup({ dataDir, outputPath, encryptionKey }) {
  const sourceRoot = resolve(dataDir);
  const sourceInfo = await stat(sourceRoot).catch(() => null);
  if (!sourceInfo?.isDirectory()) throw new Error(`data directory does not exist: ${sourceRoot}`);

  const files = [];
  for (const absolutePath of await listRegularFiles(sourceRoot)) {
    const content = await readFile(absolutePath);
    const path = portableRelativePath(sourceRoot, absolutePath);
    files.push({
      path,
      size: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString('base64')
    });
  }
  const createdAt = new Date().toISOString();
  const manifest = files.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }));
  const payload = {
    appId: BACKUP_APP_ID,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    manifestSha256: sha256(Buffer.from(JSON.stringify(manifest), 'utf8')),
    files
  };

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(encryptionKey, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(BACKUP_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const envelope = {
    algorithm: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };

  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, `${BACKUP_HEADER}${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: 'wx' });
  await ensurePrivateMode(destination, 0o600);
  return {
    path: destination,
    createdAt,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    manifestSha256: payload.manifestSha256
  };
}

export async function readAndVerifyBackup({ inputPath, encryptionKey }) {
  const absolutePath = resolve(inputPath);
  const raw = await readFile(absolutePath, 'utf8');
  if (!raw.startsWith(BACKUP_HEADER)) throw new Error('unsupported or corrupt backup header');
  let envelope;
  try {
    envelope = JSON.parse(raw.slice(BACKUP_HEADER.length));
  } catch {
    throw new Error('backup envelope is not valid JSON');
  }
  if (envelope?.algorithm !== 'aes-256-gcm+scrypt') throw new Error('unsupported backup encryption algorithm');

  let payload;
  try {
    const key = scryptSync(encryptionKey, Buffer.from(envelope.salt, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(BACKUP_AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    payload = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('backup authentication failed: wrong key or corrupt archive');
  }

  validatePayload(payload);
  return {
    path: absolutePath,
    appId: payload.appId,
    formatVersion: payload.formatVersion,
    createdAt: payload.createdAt,
    manifestSha256: payload.manifestSha256,
    fileCount: payload.files.length,
    totalBytes: payload.files.reduce((sum, file) => sum + file.size, 0),
    files: payload.files.map((file) => ({
      ...file,
      content: Buffer.from(file.contentBase64, 'base64')
    }))
  };
}

export async function restoreVerifiedBackup({ verified, dataDir, force = false }) {
  const target = resolve(dataDir);
  const parent = dirname(target);
  const targetInfo = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (targetInfo && !targetInfo.isDirectory()) throw new Error(`restore target is not a directory: ${target}`);
  const existingEntries = targetInfo ? await readdir(target) : [];
  const existingPayloadEntries = existingEntries.filter((name) => name !== SOURCE_COORDINATION_DIRECTORY_NAME);
  const coordinationPath = join(target, SOURCE_COORDINATION_DIRECTORY_NAME);
  const coordinationInfo = targetInfo
    ? await lstat(coordinationPath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      })
    : null;
  if (coordinationInfo && (!coordinationInfo.isDirectory() || coordinationInfo.isSymbolicLink())) {
    throw new Error(`restore coordination path is unsafe: ${coordinationPath}`);
  }
  if (existingPayloadEntries.length && !force) {
    throw new Error('restore target is not empty; use --force only after stopping the service and preserving the current data');
  }

  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(target, { recursive: true, mode: 0o700 });
  await ensurePrivateMode(target, 0o700);
  const staging = join(parent, `.${basename(target)}.restore-${process.pid}-${Date.now().toString(36)}`);
  const displaced = join(parent, `.${basename(target)}.previous-${process.pid}-${Date.now().toString(36)}`);
  await rm(staging, { recursive: true, force: true });
  await rm(displaced, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await mkdir(displaced, { recursive: true, mode: 0o700 });
  const movedPrevious = [];
  const movedRestored = [];
  try {
    for (const file of verified.files) {
      const destination = safeRestorePath(staging, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { mode: 0o600, flag: 'wx' });
      await ensurePrivateMode(destination, 0o600);
    }
    for (const name of existingPayloadEntries) {
      await rename(join(target, name), join(displaced, name));
      movedPrevious.push(name);
    }
    const restoredEntries = await readdir(staging);
    for (const name of restoredEntries) {
      await rename(join(staging, name), join(target, name));
      movedRestored.push(name);
    }
    await ensurePrivateMode(target, 0o700);
    await rm(staging, { recursive: true, force: true });
    await rm(displaced, { recursive: true, force: true });
  } catch (error) {
    for (const name of movedRestored.reverse()) {
      await rm(join(target, name), { recursive: true, force: true }).catch(() => {});
    }
    for (const name of movedPrevious.reverse()) {
      await rename(join(displaced, name), join(target, name)).catch(() => {});
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    const displacedEntries = await readdir(displaced).catch(() => []);
    if (!displacedEntries.length) await rm(displaced, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { dataDir: target, fileCount: verified.fileCount, totalBytes: verified.totalBytes };
}

async function listRegularFiles(root) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (directory === root && entry.name === SOURCE_COORDINATION_DIRECTORY_NAME) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in backup input: ${absolutePath}`);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) output.push(absolutePath);
    }
  }
  await visit(root);
  return output;
}

function portableRelativePath(root, absolutePath) {
  const value = relative(root, absolutePath).split(sep).join('/');
  assertSafeRelativePath(value);
  return value;
}

function safeRestorePath(root, value) {
  assertSafeRelativePath(value);
  const destination = resolve(root, ...value.split('/'));
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) throw new Error(`unsafe backup path: ${value}`);
  return destination;
}

function assertSafeRelativePath(value) {
  const path = String(value ?? '');
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe backup path: ${path}`);
  }
  if (path.split('/')[0] === SOURCE_COORDINATION_DIRECTORY_NAME) {
    throw new Error(`reserved backup path: ${path}`);
  }
}

function validatePayload(payload) {
  if (payload?.appId !== BACKUP_APP_ID || payload?.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error('backup belongs to an unsupported application or format version');
  }
  if (!Array.isArray(payload.files)) throw new Error('backup file list is missing');
  const seen = new Set();
  const manifest = [];
  for (const file of payload.files) {
    assertSafeRelativePath(file?.path);
    if (seen.has(file.path)) throw new Error(`duplicate backup path: ${file.path}`);
    seen.add(file.path);
    const content = Buffer.from(String(file.contentBase64 ?? ''), 'base64');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || content.byteLength !== file.size) {
      throw new Error(`backup size mismatch: ${file.path}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(file.sha256 ?? '')) || sha256(content) !== file.sha256) {
      throw new Error(`backup checksum mismatch: ${file.path}`);
    }
    manifest.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }
  const manifestDigest = sha256(Buffer.from(JSON.stringify(manifest), 'utf8'));
  if (manifestDigest !== payload.manifestSha256) throw new Error('backup manifest checksum mismatch');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function ensurePrivateMode(path, mode) {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, mode);
}
