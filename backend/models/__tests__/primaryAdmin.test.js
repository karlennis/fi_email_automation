/**
 * ensurePrimaryAdmin used to hash a password literal committed to the repository, so
 * anyone who had read the source could sign in as admin wherever it had not been changed.
 * The initial password now comes only from INITIAL_ADMIN_PASSWORD.
 *
 * The statics are called with a stand-in model as `this`, so nothing touches mongo.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../../utils/logger');
const User = require('../User');

/** A constructor standing in for the mongoose model. */
function fakeModel(existing = null) {
  const saved = [];
  function Model(doc) { Object.assign(this, doc); }
  Model.prototype.save = async function () { saved.push(this); return this; };
  Model.findOne = jest.fn(async () => existing);
  Model.saved = saved;
  return Model;
}

const ensure = model => User.ensurePrimaryAdmin.call(model);

describe('ensurePrimaryAdmin', () => {
  const original = process.env.INITIAL_ADMIN_PASSWORD;

  afterEach(() => {
    if (original === undefined) delete process.env.INITIAL_ADMIN_PASSWORD;
    else process.env.INITIAL_ADMIN_PASSWORD = original;
    jest.clearAllMocks();
  });

  test('creates nothing when no password is supplied', async () => {
    delete process.env.INITIAL_ADMIN_PASSWORD;
    const model = fakeModel();

    await expect(ensure(model)).resolves.toBeNull();
    expect(model.saved).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });

  test('creates nothing when the password is too short', async () => {
    process.env.INITIAL_ADMIN_PASSWORD = 'short';
    const model = fakeModel();

    await expect(ensure(model)).resolves.toBeNull();
    expect(model.saved).toHaveLength(0);
  });

  test('creates nothing from the example placeholder, however long it is', async () => {
    for (const placeholder of ['replace-with-a-long-random-password', 'changeme-changeme-changeme', 'your-admin-password-here']) {
      process.env.INITIAL_ADMIN_PASSWORD = placeholder;
      const model = fakeModel();
      await expect(ensure(model)).resolves.toBeNull();
      expect(model.saved).toHaveLength(0);
    }
  });

  test('the example env file does not ship a usable initial password', () => {
    const example = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');
    const live = example.split('\n').filter(l => /^\s*INITIAL_ADMIN_PASSWORD\s*=\s*\S/.test(l));
    expect(live).toEqual([]);
  });

  test('creates the admin from the supplied password and never logs it', async () => {
    process.env.INITIAL_ADMIN_PASSWORD = 'a-long-initial-password-42';
    const model = fakeModel();

    const admin = await ensure(model);

    expect(model.saved).toHaveLength(1);
    expect(admin.role).toBe('admin');
    expect(admin.password).not.toBe('a-long-initial-password-42');
    expect(await bcrypt.compare('a-long-initial-password-42', admin.password)).toBe(true);

    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain('a-long-initial-password-42');
  });

  test('leaves an existing admin alone, with or without the variable', async () => {
    const existing = { email: 'afatogun@buildinginfo.com', role: 'admin' };

    delete process.env.INITIAL_ADMIN_PASSWORD;
    const model = fakeModel(existing);
    await expect(ensure(model)).resolves.toBe(existing);
    expect(model.saved).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('no password literal is hashed anywhere in the model or the auth script', () => {
    for (const file of ['../User.js', '../../scripts/test-auth.js']) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/bcrypt\.hash\(\s*['"`]/);
      expect(source).not.toMatch(/password:\s*['"`][^'"`]+['"`]/);
    }
  });
});
