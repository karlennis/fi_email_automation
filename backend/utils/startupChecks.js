/**
 * Checks that must pass before the API starts serving.
 *
 * Kept free of other requires so server.js can call it straight after dotenv, before the
 * services are loaded.
 */

const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Every token the API accepts is verified against JWT_SECRET. With it unset,
 * jsonwebtoken throws on every request and nobody can log in; with a short or template
 * value, tokens can be forged offline. Either is a reason to refuse to boot. Only when
 * NODE_ENV is explicitly development or test is it left alone, so a bare checkout runs.
 *
 * Never includes the secret itself in the message.
 */
// Values shipped in .env.example and the deployment docs. Long enough to
// pass a length check, and known to anyone who has read the repository.
const PLACEHOLDER_PATTERN = /^(your[-_ ]|change[-_ ]?me|replace[-_ ]|example|secret$|jwt[-_ ]?secret)/i;

function assertJwtSecret(env = process.env) {
  // Skipped only where it is named as safe to skip. An unset or misspelt NODE_ENV is
  // treated as production, not as a development machine.
  if (['development', 'test'].includes(env.NODE_ENV)) return;

  const secret = env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start. ' +
      'Generate one with `node scripts/generate-jwt-secret.js` and set it in backend/.env.'
    );
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too short (${secret.length} characters, minimum ${MIN_JWT_SECRET_LENGTH}). ` +
      'Refusing to start. ' +
      'Generate one with `node scripts/generate-jwt-secret.js` and set it in backend/.env.'
    );
  }

  if (PLACEHOLDER_PATTERN.test(secret)) {
    throw new Error(
      'JWT_SECRET is still a placeholder from the example configuration. Refusing to start. ' +
      'Generate one with `node scripts/generate-jwt-secret.js` and set it in backend/.env.'
    );
  }
}

module.exports = {
  assertJwtSecret,
  MIN_JWT_SECRET_LENGTH
};
