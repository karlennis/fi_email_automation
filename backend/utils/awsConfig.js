/**
 * Single source of truth for the S3 bucket and AWS region.
 *
 * Three spellings of the bucket name were in use across the codebase, and the
 * one read by the scanner was not the one read by the downloader:
 *
 *   fastS3Scanner      -> S3_BUCKET_NAME   (enumerates the documents to scan)
 *   scanJobProcessor   -> S3_BUCKET        (downloads the documents it found)
 *   a few ad-hoc scripts -> AWS_S3_BUCKET_NAME
 *
 * Both sides fell back to the same 'planning-documents-2' literal, so the split
 * was invisible until someone set one of them. Setting S3_BUCKET - the variable
 * that is documented, present in .env, and forwarded by docker-compose - gave a
 * split-brain scan: the scanner listed keys from the fallback bucket while every
 * download 404'd against the configured one. The headObject failure is swallowed
 * and the getObject failure becomes stage 'download-error', which is counted as
 * unresolved but never persisted, so the night reported "0 matches" and success.
 *
 * The region had the same shape of bug: fastS3Scanner defaulted to eu-west-2
 * while .env and every other service used eu-north-1.
 *
 * This module must stay side-effect free (no S3 client, no winston) so the
 * standalone scripts under document-register/ can require it across the
 * directory boundary without dragging in a logger or an AWS connection.
 */

const DEFAULT_BUCKET = 'planning-documents-2';
const DEFAULT_REGION = 'eu-north-1';

// Ordered by precedence. S3_BUCKET is canonical; the rest are legacy aliases
// kept working so an existing deployment does not break on upgrade.
const BUCKET_VARS = ['S3_BUCKET', 'S3_BUCKET_NAME', 'AWS_S3_BUCKET_NAME'];
const REGION_VARS = ['AWS_REGION', 'S3_REGION'];

function firstSet(names, env) {
  for (const name of names) {
    const value = env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return null;
}

/**
 * The S3 bucket holding filter-docs/ and planning-docs/.
 * @param {object} env - defaults to process.env; injectable for tests
 */
function getBucket(env = process.env) {
  return firstSet(BUCKET_VARS, env) || DEFAULT_BUCKET;
}

/**
 * The AWS region for every S3 client in the backend.
 * @param {object} env - defaults to process.env; injectable for tests
 */
function getRegion(env = process.env) {
  return firstSet(REGION_VARS, env) || DEFAULT_REGION;
}

/**
 * Fail fast at boot when two spellings of the same setting disagree.
 *
 * Presence of an alias is fine - plenty of deployments set both to the same
 * string. Only a genuine disagreement is fatal, because that is the case where
 * getBucket()'s precedence silently picks a winner and half the pipeline points
 * somewhere the other half does not.
 *
 * @throws {Error} when two variables for the same setting hold different values
 */
function assertConsistentS3Env(env = process.env) {
  const problems = [];

  for (const [label, names] of [['bucket', BUCKET_VARS], ['region', REGION_VARS]]) {
    const set = names
      .filter(name => env[name] && String(env[name]).trim())
      .map(name => ({ name, value: String(env[name]).trim() }));

    const distinct = new Set(set.map(entry => entry.value));
    if (distinct.size > 1) {
      const detail = set.map(entry => `${entry.name}=${entry.value}`).join(', ');
      problems.push(`conflicting ${label} configuration: ${detail}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid AWS environment - ${problems.join('; ')}. ` +
      `Set S3_BUCKET and AWS_REGION only; the other spellings are legacy aliases ` +
      `and must not point somewhere different.`
    );
  }

  return { bucket: getBucket(env), region: getRegion(env) };
}

module.exports = {
  getBucket,
  getRegion,
  assertConsistentS3Env,
  DEFAULT_BUCKET,
  DEFAULT_REGION,
  BUCKET_VARS,
  REGION_VARS
};
