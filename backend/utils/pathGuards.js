/**
 * Guards for caller-supplied filesystem paths and S3 locations.
 *
 * Pure functions, no I/O: the routes decide what to do with a rejection.
 */

const path = require('path');

// The only top-level S3 folders the API may be pointed at by a caller.
const ALLOWED_S3_FOLDERS = ['planning-docs', 'filter-docs'];
const ALLOWED_S3_PREFIXES = ALLOWED_S3_FOLDERS.map(folder => `${folder}/`);

/**
 * The local file browser is a development convenience. It is off unless explicitly
 * switched on, and can only be switched on when NODE_ENV is development or test.
 */
function isLocalBrowserEnabled(env = process.env) {
  // An allow-list, not "anything but production": an unset or misspelt NODE_ENV
  // ('Production', 'prod') must leave the browser off, not switch it on.
  return env.ENABLE_LOCAL_FILE_BROWSER === 'true' && ['development', 'test'].includes(env.NODE_ENV);
}

/** The configured browse root as an absolute path, or null when none is configured. */
function getLocalBrowseRoot(env = process.env) {
  const root = env.LOCAL_BROWSE_ROOT;
  if (!root || !String(root).trim()) return null;
  const resolved = path.resolve(String(root).trim());
  // A filesystem or drive root would make "inside the root" mean "anywhere".
  if (path.parse(resolved).root === resolved) return null;
  return resolved;
}

/**
 * True when `candidate` is `root` itself or sits underneath it. Both must already be
 * absolute. The separator is appended before the prefix test so that /data/docs-private
 * is not mistaken for a child of /data/docs.
 */
function isInsideRoot(root, candidate, pathImpl = path) {
  const caseInsensitive = pathImpl === path.win32 || (pathImpl === path && process.platform === 'win32');
  const normalise = value => (caseInsensitive ? value.toLowerCase() : value);

  const rootNorm = normalise(pathImpl.resolve(root));
  const candidateNorm = normalise(pathImpl.resolve(candidate));

  if (candidateNorm === rootNorm) return true;

  const rootWithSep = rootNorm.endsWith(pathImpl.sep) ? rootNorm : rootNorm + pathImpl.sep;
  return candidateNorm.startsWith(rootWithSep);
}

/**
 * Resolve a caller-supplied path against the browse root.
 * Returns the absolute path, or null when it is unusable or escapes the root.
 * Relative input is resolved against the root, not the process working directory.
 */
function resolveInsideRoot(root, requested, pathImpl = path) {
  if (!root) return null;
  if (typeof requested !== 'string' || requested.length === 0) return null;
  if (requested.includes('\0')) return null;

  const absoluteRoot = pathImpl.resolve(root);
  const absolute = pathImpl.resolve(absoluteRoot, requested);

  return isInsideRoot(absoluteRoot, absolute, pathImpl) ? absolute : null;
}

/** 'planning-docs' or 'planning-docs/' -> 'planning-docs'; anything else -> null. */
function normaliseS3Folder(folderName) {
  if (typeof folderName !== 'string') return null;
  const trimmed = folderName.trim().replace(/\/+$/, '');
  return ALLOWED_S3_FOLDERS.includes(trimmed) ? trimmed : null;
}

/**
 * Project ids become part of an S3 prefix, so they must be a single path segment:
 * no slashes, no dot segments, nothing that could widen the listing.
 */
function isSafeProjectId(projectId) {
  if (typeof projectId !== 'string' && typeof projectId !== 'number') return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(projectId));
}

/** A full S3 key supplied by a caller must live under one of the allowed prefixes. */
function isAllowedS3Key(key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) return false;
  if (key.split('/').some(segment => segment === '..' || segment === '.')) return false;
  return ALLOWED_S3_PREFIXES.some(prefix => key.startsWith(prefix) && key.length > prefix.length);
}

module.exports = {
  ALLOWED_S3_FOLDERS,
  ALLOWED_S3_PREFIXES,
  isLocalBrowserEnabled,
  getLocalBrowseRoot,
  isInsideRoot,
  resolveInsideRoot,
  normaliseS3Folder,
  isSafeProjectId,
  isAllowedS3Key
};
