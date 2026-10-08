// H5: projections let hot paths that only need a few fields (version chains,
// audits, feedback history) cache slim rows instead of full routebook snapshots.
// Projected rows live under their own cache key, so full-row readers are unaffected.
export const ROUTEBOOK_HISTORY_FIELDS = [
  'id', 'publicId', 'title', 'city', 'version', 'parentVersion', 'schemaVersion', 'publishStatus',
  'changeReason', 'editReason', 'actorType', 'profileId', 'createdAt', 'updatedAt', 'publishedAt',
  'archivedAt', 'versionAudit', 'activeVariantId'
];
export const ROUTEBOOK_HISTORY_PROJECTION = {
  name: 'routebook-history',
  project(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const projected = {};
    for (const key of ROUTEBOOK_HISTORY_FIELDS) {
      if (row[key] !== undefined) projected[key] = row[key];
    }
    if (row.provider && typeof row.provider === 'object' && row.provider.editedAt !== undefined) {
      projected.provider = { editedAt: row.provider.editedAt };
    }
    return projected;
  }
};
