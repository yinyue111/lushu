import { CONFIG_DOCUMENTS, EVENT_STREAMS } from './contract.mjs';
import { canonicalJson, eventSequenceSha256, jsonSha256, sha256 } from './jsonCanonical.mjs';

export const STORAGE_SNAPSHOT_FORMAT_VERSION = 1;

export function buildStorageSnapshot({ streams = {}, configs = {}, source = 'unknown' } = {}) {
  const normalizedStreams = {};
  for (const definition of EVENT_STREAMS) {
    const entry = streams[definition.name] ?? {};
    const rows = Array.isArray(entry.rows) ? entry.rows : [];
    normalizedStreams[definition.name] = {
      fileName: definition.fileName,
      present: entry.present !== false,
      rows,
      count: rows.length,
      sha256: eventSequenceSha256(rows),
      ...(entry.rawSha256 ? { rawSha256: entry.rawSha256 } : {})
    };
  }

  const normalizedConfigs = {};
  for (const definition of CONFIG_DOCUMENTS) {
    const entry = configs[definition.name] ?? {};
    const present = entry.present === true;
    normalizedConfigs[definition.name] = {
      fileName: definition.fileName,
      present,
      document: present ? entry.document : null,
      sha256: present ? jsonSha256(entry.document) : null,
      ...(entry.rawSha256 ? { rawSha256: entry.rawSha256 } : {})
    };
  }

  const manifest = storageSnapshotManifest({ streams: normalizedStreams, configs: normalizedConfigs });
  return {
    formatVersion: STORAGE_SNAPSHOT_FORMAT_VERSION,
    source,
    streams: normalizedStreams,
    configs: normalizedConfigs,
    manifest,
    manifestSha256: sha256(canonicalJson(manifest))
  };
}

export function storageSnapshotManifest(snapshot) {
  const streams = {};
  for (const definition of EVENT_STREAMS) {
    const entry = snapshot.streams[definition.name];
    streams[definition.name] = {
      fileName: definition.fileName,
      count: entry.count,
      sha256: entry.sha256
    };
  }
  const configs = {};
  for (const definition of CONFIG_DOCUMENTS) {
    const entry = snapshot.configs[definition.name];
    configs[definition.name] = {
      fileName: definition.fileName,
      present: entry.present,
      sha256: entry.sha256
    };
  }
  return {
    formatVersion: STORAGE_SNAPSHOT_FORMAT_VERSION,
    streams,
    configs
  };
}

export function compareStorageSnapshots(expected, actual) {
  /** @type {Array<Record<string, any>>} */
  const differences = [];
  for (const definition of EVENT_STREAMS) {
    const left = expected.streams[definition.name];
    const right = actual.streams[definition.name];
    if (left.count !== right.count || left.sha256 !== right.sha256) {
      differences.push({
        kind: 'event-stream',
        name: definition.name,
        expectedCount: left.count,
        actualCount: right.count,
        expectedSha256: left.sha256,
        actualSha256: right.sha256
      });
    }
  }
  for (const definition of CONFIG_DOCUMENTS) {
    const left = expected.configs[definition.name];
    const right = actual.configs[definition.name];
    if (left.present !== right.present || left.sha256 !== right.sha256) {
      differences.push({
        kind: 'config-document',
        name: definition.name,
        expectedPresent: left.present,
        actualPresent: right.present,
        expectedSha256: left.sha256,
        actualSha256: right.sha256
      });
    }
  }
  return {
    matches: differences.length === 0,
    expectedManifestSha256: expected.manifestSha256,
    actualManifestSha256: actual.manifestSha256,
    differences
  };
}
