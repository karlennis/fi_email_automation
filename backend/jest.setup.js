/**
 * Test environment setup - runs before any test module is required.
 *
 * emailService calls dotenv.config() at import time and then, if SMTP_USER is set,
 * builds a nodemailer transporter and immediately calls transporter.verify(). On a
 * developer machine with a real backend/.env that opens a live SMTP socket during the
 * test run, which Jest reports as an open handle and which stops the process exiting.
 *
 * Clearing the credentials here takes the service's own "SMTP credentials not
 * configured, email service disabled" branch - the same path it follows on a box
 * without mail configured - so sends become no-ops returning
 * { success: false, reason: 'Email service not configured' } instead of reaching the
 * network. Tests that care about send behaviour spy on the service methods directly.
 *
 * This must be a `setupFiles` entry, not `setupFilesAfterEnv`: the transporter is built
 * in the module constructor, so the variables have to be neutralised before the first
 * require.
 *
 * They are set to '' rather than deleted. emailService calls dotenv.config() itself at
 * import, and dotenv only skips a key that is already an own property of process.env -
 * so a deleted variable is simply reloaded from backend/.env and the socket opens
 * anyway. An empty string is an own property, so dotenv leaves it alone, and the
 * service's `!process.env.SMTP_USER` guard treats it as unconfigured.
 */

process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.SMTP_HOST = '';

// Belt and braces: nothing in a test run should be talking to a real service.
process.env.NODE_ENV = 'test';
