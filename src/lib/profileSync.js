import { replaceProfile } from './profile.js';
import { migrateLocalProfileData } from './storage.js';

const EMPTY_MIGRATION = Object.freeze({ routebooks: 0, checkins: 0, clicks: 0, favorites: 0 });

export function adoptServerProfile(serverProfile, currentProfile = {}) {
  const candidate = serverProfile && typeof serverProfile === 'object' ? serverProfile : currentProfile;
  const nextId = String(candidate?.id ?? '').trim();
  const currentId = String(currentProfile?.id ?? '').trim();
  const previousId = String(candidate?.previousLocalId || (currentId && currentId !== nextId ? currentId : '')).trim();
  const migration = previousId && nextId && previousId !== nextId ? migrateLocalProfileData(previousId, nextId) : { ...EMPTY_MIGRATION };
  const profile = replaceProfile(candidate);
  const migratedCount = Object.values(migration).reduce((sum, value) => sum + Number(value || 0), 0);
  return { profile, migration, migratedCount };
}
