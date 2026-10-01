/**
 * Access control for the whole API.
 *
 * Until routes/index.js existed, nine of the fourteen routers had no authentication at
 * all - including the one that browsed the server's filesystem from a path in the query
 * string, on a machine whose backend/.env held an AWS key that was later stolen.
 *
 * These tests use the real mount table, the real middleware and real signed tokens. Only
 * the User model and the network-facing services are mocked, so a test here fails if the
 * protection is removed rather than passing because a mock stood in for it.
 *
 * Offline: no mongo, redis, S3, OpenAI or SMTP.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

// --- mocks -----------------------------------------------------------------------------

const mockUsers = {
  admin: { _id: 'u-admin', email: 'admin@buildinginfo.com', role: 'admin', isActive: true },
  operator: { _id: 'u-op', email: 'op@buildinginfo.com', role: 'operator', isActive: true },
  inactive: { _id: 'u-off', email: 'off@buildinginfo.com', role: 'admin', isActive: false },
  outsider: { _id: 'u-out', email: 'someone@example.com', role: 'admin', isActive: true }
};

// Switches the tests flip to make the database misbehave.
const mockDb = { findThrows: false, saveThrows: false, saved: [] };

// As the pre-save hook in models/User.js sets them.
const mockPermissions = {
  admin: { canManageUsers: true, canManageJobs: true, canViewAllJobs: true, canManageSystem: true },
  operator: { canManageUsers: false, canManageJobs: true, canViewAllJobs: false, canManageSystem: false }
};

jest.mock('../../models/User', () => {
  const bcrypt = require('bcryptjs');
  const findById = jest.fn(id => ({
    select: async (fields) => {
      if (mockDb.findThrows) throw new Error('MongoNetworkTimeoutError');
      const found = Object.values(mockUsers).find(u => String(u._id) === String(id));
      if (!found) return null;
      const doc = {
        ...found,
        permissions: mockPermissions[found.role],
        save: async function () {
          if (mockDb.saveThrows) throw new Error('write failed');
          mockDb.saved.push({ _id: this._id, password: this.password });
        },
        hasPermission: permission => mockPermissions[found.role][permission] === true
      };
      // The hash is only present when a caller asks for it, as with the real schema query.
      if (fields === '+password') doc.password = bcrypt.hashSync('Current-Passw0rd!', 4);
      return doc;
    }
  }));
  return { findById, findOne: jest.fn(), ensurePrimaryAdmin: jest.fn() };
});

jest.mock('../../services/s3Service', () => ({}));
jest.mock('../../services/buildingInfoService', () => ({}));
jest.mock('../../services/emailService', () => ({}));
jest.mock('../../services/fiDetectionService', () => ({}));
jest.mock('../../models/Customer', () => ({}));
jest.mock('../../models/Project', () => ({}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { mountRoutes, ROUTE_TABLE, PUBLIC_PATHS } = require('../index');

// --- helpers ---------------------------------------------------------------------------

const tokenFor = (user, options = {}) =>
  jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h', ...options });

/** A router that answers everything, standing in for a real route file. */
function openRouter() {
  const router = express.Router();
  router.all('*', (req, res) => res.json({ reached: true }));
  return router;
}

/** The real table and the real guards, with stand-in routers behind them. */
function appWithRealTable() {
  const app = express();
  app.use(express.json());
  mountRoutes(app, ROUTE_TABLE.map(route => ({ ...route, load: openRouter })));
  return app;
}

const protectedRoutes = ROUTE_TABLE.filter(route => route.access !== 'public');
const adminRoutes = ROUTE_TABLE.filter(route => route.access === 'admin');

// --- the mount table -------------------------------------------------------------------

describe('mount table', () => {
  test('only /api/auth is public', () => {
    expect(PUBLIC_PATHS).toEqual(['/api/auth']);
    expect(ROUTE_TABLE.filter(r => r.access === 'public').map(r => r.path)).toEqual(['/api/auth']);
  });

  test('every router that server.js used to mount is still in the table', () => {
    expect(ROUTE_TABLE.map(r => r.path).sort()).toEqual([
      '/api/auth', '/api/customers', '/api/document-register', '/api/document-scan',
      '/api/documents', '/api/documents-browser', '/api/filtering', '/api/jobs',
      '/api/projects', '/api/register-fi', '/api/reports', '/api/runs',
      '/api/scheduled-jobs'
    ]);
  });

  test('the file browser and the routers no page uses are admin-only', () => {
    expect(adminRoutes.map(r => r.path).sort()).toEqual([
      '/api/documents', '/api/documents-browser', '/api/jobs', '/api/runs',
      '/api/scheduled-jobs'
    ]);
  });

  test('the routers the operator pages call stay open to operators', () => {
    const operatorRouters = ROUTE_TABLE.filter(r => r.access === 'authenticated').map(r => r.path).sort();
    expect(operatorRouters).toEqual([
      '/api/customers', '/api/document-register', '/api/document-scan', '/api/filtering',
      '/api/projects', '/api/register-fi', '/api/reports'
    ]);
  });

  test('a route with no access level refuses to mount', () => {
    const app = express();
    expect(() => mountRoutes(app, [{ path: '/api/new-thing', load: openRouter }])).toThrow(/access level/);
  });

  test('a route cannot be made public just by saying so', () => {
    const app = express();
    expect(() => mountRoutes(app, [{ path: '/api/new-thing', access: 'public', load: openRouter }]))
      .toThrow(/PUBLIC_PATHS/);
  });

  test('a bad entry mounts nothing, not half the table', () => {
    const app = express();
    const table = [
      { path: '/api/ok', access: 'authenticated', load: openRouter },
      { path: '/api/bad', load: openRouter }
    ];
    expect(() => mountRoutes(app, table)).toThrow();
    expect(app._router).toBeUndefined();
  });

  test('server.js mounts through the table and nowhere else', () => {
    // Comments are stripped: server.js explains in one why app.use('/api/...') is banned.
    const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    expect(source).toMatch(/mountRoutes\(app\)/);
    expect(source).not.toMatch(/app\.use\(\s*['"`]\/api/);
  });
});

// --- authentication on every router ----------------------------------------------------

describe('every protected router', () => {
  const app = appWithRealTable();

  test.each(protectedRoutes.map(r => [r.path]))('%s rejects a request with no token', async (routePath) => {
    for (const method of ['get', 'post', 'put', 'delete']) {
      const res = await request(app)[method](`${routePath}/anything`);
      expect(res.status).toBe(401);
      expect(res.body.reached).toBeUndefined();
    }
  });

  test.each(protectedRoutes.map(r => [r.path]))('%s rejects a forged or malformed token', async (routePath) => {
    const forged = jwt.sign({ userId: mockUsers.admin._id }, 'not-the-server-secret-but-long-enough-0123456789');
    const unsigned = jwt.sign({ userId: mockUsers.admin._id }, '', { algorithm: 'none' });

    for (const token of [forged, unsigned, 'garbage', '']) {
      const res = await request(app).get(`${routePath}/anything`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  test.each(protectedRoutes.map(r => [r.path]))('%s rejects an expired token', async (routePath) => {
    const expired = tokenFor(mockUsers.admin, { expiresIn: -10 });
    const res = await request(app).get(`${routePath}/anything`).set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  test('a token signed with another algorithm is rejected', async () => {
    const hs512 = jwt.sign({ userId: mockUsers.admin._id }, process.env.JWT_SECRET, { algorithm: 'HS512' });
    const res = await request(app).get('/api/reports/anything').set('Authorization', `Bearer ${hs512}`);
    expect(res.status).toBe(401);
  });

  test('a deactivated user, an unknown user and a non-company address are all refused', async () => {
    const inactive = await request(app).get('/api/reports/x').set('Authorization', `Bearer ${tokenFor(mockUsers.inactive)}`);
    expect(inactive.status).toBe(401);

    const unknown = await request(app).get('/api/reports/x').set('Authorization', `Bearer ${tokenFor({ _id: 'nobody' })}`);
    expect(unknown.status).toBe(401);

    const outsider = await request(app).get('/api/reports/x').set('Authorization', `Bearer ${tokenFor(mockUsers.outsider)}`);
    expect(outsider.status).toBe(403);
  });

  test.each(protectedRoutes.filter(r => r.access === 'authenticated').map(r => [r.path]))(
    '%s lets a signed-in operator through', async (routePath) => {
      const res = await request(app).get(`${routePath}/anything`).set('Authorization', `Bearer ${tokenFor(mockUsers.operator)}`);
      expect(res.status).toBe(200);
      expect(res.body.reached).toBe(true);
    });

  test.each(adminRoutes.map(r => [r.path]))('%s refuses an operator and admits an admin', async (routePath) => {
    const asOperator = await request(app).get(`${routePath}/anything`).set('Authorization', `Bearer ${tokenFor(mockUsers.operator)}`);
    expect(asOperator.status).toBe(403);
    expect(asOperator.body.reached).toBeUndefined();

    const asAdmin = await request(app).get(`${routePath}/anything`).set('Authorization', `Bearer ${tokenFor(mockUsers.admin)}`);
    expect(asAdmin.status).toBe(200);
  });
});

// --- a failing database ----------------------------------------------------------------

describe('authenticate when the database misbehaves', () => {
  const app = appWithRealTable();
  afterEach(() => { mockDb.findThrows = false; mockDb.saveThrows = false; });

  test('a lookup failure is 503, not 401 - the frontend logs users out on 401', async () => {
    mockDb.findThrows = true;
    const res = await request(app).get('/api/reports/x').set('Authorization', `Bearer ${tokenFor(mockUsers.operator)}`);
    expect(res.status).toBe(503);
    expect(res.body.reached).toBeUndefined();
  });

  test('a failed last-activity write does not reject a valid session', async () => {
    mockDb.saveThrows = true;
    const res = await request(app).get('/api/reports/x').set('Authorization', `Bearer ${tokenFor(mockUsers.operator)}`);
    expect(res.status).toBe(200);
  });
});

// --- guards inside the route files -----------------------------------------------------

describe('per-route guards', () => {
  // The mount table cannot express "this one route is admin-only", so these live in the
  // route files. Read from source: loading every router would need every service mocked,
  // and the thing to catch is the guard being deleted from the route line.
  const guarded = [
    ['api-filtering.js', "router.post('/process-fi-with-filters'", 'requireAdmin'],
    ['api-filtering.js', "router.post('/preview-projects'", 'requireAdmin'],
    ['api-filtering.js', "router.post('/check-filter-impact'", 'requireAdmin'],
    ['document-register.js', "router.post('/scheduler/run'", 'requireAdmin'],
    ['document-register.js', "router.get('/count'", 'requireAdmin'],
    ['documents.js', "router.post('/cleanup-cache'", 'requireAdmin'],
    ['jobs.js', "router.post('/schedule-project'", 'requireAdmin'],
    ['jobs.js', "router.post('/schedule-batch'", 'requireAdmin'],
    ['jobs.js', "router.delete('/:jobId'", 'requireAdmin'],
    ['reports.js', "router.post('/archive'", 'requireAdmin'],
    ['reports.js', "router.delete('/cleanup'", 'requireAdmin'],
    ['runs.js', "router.post('/daily'", 'requireAdmin'],
    ['runs.js', "router.post('/:runId/retry-failed'", 'requireAdmin'],
    ['runs.js', "router.post('/:runId/reconcile'", 'requireAdmin'],
    ['scheduled-jobs.js', "router.post('/:jobId/cancel'", 'requireAdmin'],
    ['scheduled-jobs.js', "router.post('/:jobId/execute-now'", 'requireAdmin'],
    ['scheduled-jobs.js', "router.post('/send-immediate'", 'requireAdmin'],
    ['auth.js', "router.post('/users'", "requirePermission('canManageUsers')"],
    ['auth.js', "router.get('/users'", "requirePermission('canManageUsers')"],
    ['auth.js', "router.put('/users/:id'", "requirePermission('canManageUsers')"],
    ['auth.js', "router.delete('/users/:id'", "requirePermission('canManageUsers')"],
    ['auth.js', "router.post('/login'", 'loginLimiter']
  ];

  test.each(guarded)('%s %s carries %s', (file, route, guard) => {
    const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
    const line = lines.find(l => l.trim().startsWith(route + ','));
    expect(line).toBeDefined();
    expect(line).toContain(guard);
  });

  test('requirePermission fails closed without a user, and honours real operator permissions', async () => {
    const { authenticate, requirePermission } = require('../../middleware/auth');
    const app = express();
    app.get('/bare', requirePermission('canManageJobs'), (req, res) => res.json({ reached: true }));
    app.get('/jobs', authenticate, requirePermission('canManageJobs'), (req, res) => res.json({ reached: true }));
    app.get('/users', authenticate, requirePermission('canManageUsers'), (req, res) => res.json({ reached: true }));

    expect((await request(app).get('/bare')).status).toBe(401);
    const operator = `Bearer ${tokenFor(mockUsers.operator)}`;
    expect((await request(app).get('/jobs').set('Authorization', operator)).status).toBe(200);
    expect((await request(app).get('/users').set('Authorization', operator)).status).toBe(403);
  });
});

// --- changing a password ---------------------------------------------------------------

describe('POST /api/auth/change-password', () => {
  // authenticate strips the hash from req.user, so the old check compared against
  // undefined and never ran: any valid token could set a new password.
  const app = express();
  app.use(express.json());
  mountRoutes(app, ROUTE_TABLE.filter(r => r.path === '/api/auth'));
  const operator = () => `Bearer ${tokenFor(mockUsers.operator)}`;
  const change = body => request(app).post('/api/auth/change-password').set('Authorization', operator()).send(body);

  beforeEach(() => { mockDb.saved.length = 0; });

  test('refuses without the current password', async () => {
    expect((await change({ newPassword: 'Brand-New-Passw0rd!' })).status).toBe(400);
    expect(mockDb.saved.filter(s => s.password)).toHaveLength(0);
  });

  test('refuses a wrong current password, and a non-string one', async () => {
    expect((await change({ currentPassword: 'wrong', newPassword: 'Brand-New-Passw0rd!' })).status).toBe(400);
    expect((await change({ currentPassword: { $ne: null }, newPassword: 'Brand-New-Passw0rd!' })).status).toBe(400);
    expect((await change({ currentPassword: 'Current-Passw0rd!', newPassword: { $ne: null } })).status).toBe(400);
    expect(mockDb.saved.filter(s => s.password)).toHaveLength(0);
  });

  test('accepts the right current password and stores a new hash', async () => {
    const res = await change({ currentPassword: 'Current-Passw0rd!', newPassword: 'Brand-New-Passw0rd!' });
    expect(res.status).toBe(200);
    const stored = mockDb.saved.filter(s => s.password);
    expect(stored).toHaveLength(1);
    expect(stored[0].password).not.toContain('Brand-New-Passw0rd!');
    expect(await require('bcryptjs').compare('Brand-New-Passw0rd!', stored[0].password)).toBe(true);
  });
});

// --- requireAdmin on its own -----------------------------------------------------------

describe('requireAdmin', () => {
  const { requireAdmin } = require('../../middleware/auth');

  test('fails closed when mounted without authenticate in front of it', async () => {
    const app = express();
    app.get('/x', requireAdmin, (req, res) => res.json({ reached: true }));
    const res = await request(app).get('/x');
    expect(res.status).toBe(401);
  });
});

// --- login stays reachable -------------------------------------------------------------

describe('/api/auth', () => {
  test('login is reachable without a token; the rest of the auth router is not', async () => {
    const app = express();
    app.use(express.json());
    mountRoutes(app, ROUTE_TABLE.filter(r => r.path === '/api/auth'));

    // Reaches the handler: a validation or credentials answer, not "no token".
    const login = await request(app).post('/api/auth/login').send({});
    expect(login.status).toBe(400);
    expect(JSON.stringify(login.body)).not.toMatch(/No token provided/);

    expect((await request(app).get('/api/auth/users')).status).toBe(401);
    expect((await request(app).post('/api/auth/users').send({})).status).toBe(401);
    expect((await request(app).put('/api/auth/users/1').send({})).status).toBe(401);
    expect((await request(app).delete('/api/auth/users/1')).status).toBe(401);
    expect((await request(app).post('/api/auth/change-password').send({})).status).toBe(401);
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });
});

// --- the local file browser ------------------------------------------------------------

describe('/api/documents-browser/local', () => {
  const saved = { ...process.env };
  let root;
  let outside;
  let app;
  const admin = () => `Bearer ${tokenFor(mockUsers.admin)}`;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-browse-'));
    root = path.join(base, 'docs');
    outside = path.join(base, 'docs-private'); // shares the root's prefix on purpose
    fs.mkdirSync(path.join(root, 'project-1'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, '.env'), 'SECRET=1');

    app = express();
    app.use(express.json());
    mountRoutes(app, ROUTE_TABLE.filter(r => r.path === '/api/documents-browser'));
  });

  afterEach(() => {
    for (const key of ['ENABLE_LOCAL_FILE_BROWSER', 'LOCAL_BROWSE_ROOT', 'NODE_ENV']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const localRequests = () => [
    request(app).get('/api/documents-browser/local/drives'),
    request(app).get('/api/documents-browser/local/browse').query({ path: root }),
    request(app).post('/api/documents-browser/local/scan-projects').send({ rootPath: root }),
    request(app).post('/api/documents-browser/local/process-folder').send({ folderPaths: [root] }),
    request(app).post('/api/documents-browser/local/process-fi').send({ projectPaths: [root] })
  ];

  test('needs a token even when switched on', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    process.env.LOCAL_BROWSE_ROOT = root;
    for (const req of localRequests()) {
      expect((await req).status).toBe(401);
    }
  });

  test('does not exist by default', async () => {
    delete process.env.ENABLE_LOCAL_FILE_BROWSER;
    process.env.LOCAL_BROWSE_ROOT = root;
    for (const req of localRequests()) {
      expect((await req.set('Authorization', admin())).status).toBe(404);
    }
  });

  test('does not exist in production, whatever the flag says', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    process.env.LOCAL_BROWSE_ROOT = root;
    process.env.NODE_ENV = 'production';
    for (const req of localRequests()) {
      expect((await req.set('Authorization', admin())).status).toBe(404);
    }
  });

  test('does not exist when NODE_ENV is unset or misspelt', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    process.env.LOCAL_BROWSE_ROOT = root;
    for (const value of [undefined, 'Production', 'prod', 'staging']) {
      if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
      const res = await request(app).get('/api/documents-browser/local/drives').set('Authorization', admin());
      expect(res.status).toBe(404);
    }
  });

  test('refuses a filesystem root as the browse root', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    process.env.LOCAL_BROWSE_ROOT = path.parse(root).root;
    const res = await request(app).get('/api/documents-browser/local/browse')
      .query({ path: os.homedir() }).set('Authorization', admin());
    expect(res.status).toBe(400);
  });

  test('refuses to run without a configured root', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    delete process.env.LOCAL_BROWSE_ROOT;
    const res = await request(app).get('/api/documents-browser/local/browse').set('Authorization', admin());
    expect(res.status).toBe(400);
  });

  test('browses inside the root', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    process.env.LOCAL_BROWSE_ROOT = root;
    const res = await request(app).get('/api/documents-browser/local/browse')
      .query({ path: root }).set('Authorization', admin());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/project-1/);
  });

  test('rejects every way out of the root', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    process.env.LOCAL_BROWSE_ROOT = root;

    const escapes = [
      outside,                                  // sibling sharing the prefix
      path.join(root, '..'),
      path.join(root, '..', 'docs-private'),
      `${root}${path.sep}..${path.sep}docs-private`,
      '../docs-private',
      '..',
      path.parse(root).root,                    // filesystem / drive root
      os.homedir(),
      `${root}\0`
    ];

    for (const attempt of escapes) {
      const browse = await request(app).get('/api/documents-browser/local/browse')
        .query({ path: attempt }).set('Authorization', admin());
      expect(browse.status).toBe(400);
      expect(JSON.stringify(browse.body)).not.toMatch(/\.env/);

      const scan = await request(app).post('/api/documents-browser/local/scan-projects')
        .send({ rootPath: attempt }).set('Authorization', admin());
      expect(scan.status).toBe(400);
    }
  });

  test('one bad path rejects the whole batch', async () => {
    process.env.ENABLE_LOCAL_FILE_BROWSER = 'true';
    process.env.LOCAL_BROWSE_ROOT = root;
    const res = await request(app).post('/api/documents-browser/local/process-fi')
      .send({ projectPaths: [path.join(root, 'project-1'), outside], reportTypes: ['acoustic'], customerEmails: ['a@buildinginfo.com'] })
      .set('Authorization', admin());
    expect(res.status).toBe(400);
  });

  test('S3 folder and project id are constrained', async () => {
    const badFolder = await request(app).get('/api/documents-browser/aws/folders/secrets/projects').set('Authorization', admin());
    expect(badFolder.status).toBe(400);

    const badProject = await request(app).get('/api/documents-browser/aws/projects/..%2F..%2Fother').set('Authorization', admin());
    expect(badProject.status).toBe(400);
  });
});

// --- path guards -----------------------------------------------------------------------

describe('pathGuards', () => {
  const guards = require('../../utils/pathGuards');

  test('prefix siblings are not children (posix and windows)', () => {
    expect(guards.isInsideRoot('/data/docs', '/data/docs/a', path.posix)).toBe(true);
    expect(guards.isInsideRoot('/data/docs', '/data/docs', path.posix)).toBe(true);
    expect(guards.isInsideRoot('/data/docs', '/data/docs-private', path.posix)).toBe(false);
    expect(guards.isInsideRoot('/data/docs', '/data', path.posix)).toBe(false);

    expect(guards.isInsideRoot('C:\\data\\docs', 'c:\\DATA\\docs\\a', path.win32)).toBe(true);
    expect(guards.isInsideRoot('C:\\data\\docs', 'C:\\data\\docs-private', path.win32)).toBe(false);
    expect(guards.isInsideRoot('C:\\data\\docs', 'D:\\data\\docs', path.win32)).toBe(false);
  });

  test('resolveInsideRoot refuses traversal, absolute escapes, UNC and empty input', () => {
    expect(guards.resolveInsideRoot('/data/docs', 'a/b', path.posix)).toBe('/data/docs/a/b');
    expect(guards.resolveInsideRoot('/data/docs', '../x', path.posix)).toBeNull();
    expect(guards.resolveInsideRoot('/data/docs', '/etc/passwd', path.posix)).toBeNull();
    expect(guards.resolveInsideRoot('/data/docs', 'a/../../x', path.posix)).toBeNull();
    expect(guards.resolveInsideRoot('/data/docs', '', path.posix)).toBeNull();
    expect(guards.resolveInsideRoot('/data/docs', undefined, path.posix)).toBeNull();
    expect(guards.resolveInsideRoot('/data/docs', { path: '/x' }, path.posix)).toBeNull();
    expect(guards.resolveInsideRoot(null, 'a', path.posix)).toBeNull();
    expect(guards.resolveInsideRoot('C:\\data\\docs', '\\\\server\\share\\x', path.win32)).toBeNull();
    expect(guards.resolveInsideRoot('C:\\data\\docs', 'a/..\\..\\x', path.win32)).toBeNull();
  });

  test('the browser cannot be enabled in production', () => {
    expect(guards.isLocalBrowserEnabled({ ENABLE_LOCAL_FILE_BROWSER: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(guards.isLocalBrowserEnabled({ ENABLE_LOCAL_FILE_BROWSER: 'true', NODE_ENV: 'test' })).toBe(true);
    expect(guards.isLocalBrowserEnabled({ ENABLE_LOCAL_FILE_BROWSER: 'true', NODE_ENV: 'production' })).toBe(false);
    expect(guards.isLocalBrowserEnabled({ ENABLE_LOCAL_FILE_BROWSER: 'true', NODE_ENV: 'Production' })).toBe(false);
    expect(guards.isLocalBrowserEnabled({ ENABLE_LOCAL_FILE_BROWSER: 'true' })).toBe(false);
    expect(guards.getLocalBrowseRoot({ LOCAL_BROWSE_ROOT: path.parse(process.cwd()).root })).toBeNull();
    expect(guards.getLocalBrowseRoot({ LOCAL_BROWSE_ROOT: '  ' })).toBeNull();
    expect(guards.isLocalBrowserEnabled({ ENABLE_LOCAL_FILE_BROWSER: '1' })).toBe(false);
    expect(guards.isLocalBrowserEnabled({})).toBe(false);
  });

  test('S3 keys, folders and project ids', () => {
    expect(guards.isAllowedS3Key('planning-docs/123/a.pdf')).toBe(true);
    expect(guards.isAllowedS3Key('filter-docs/123/a.pdf')).toBe(true);
    expect(guards.isAllowedS3Key('planning-docs/')).toBe(false);
    expect(guards.isAllowedS3Key('planning-docs/../secrets/a')).toBe(false);
    expect(guards.isAllowedS3Key('secrets/a')).toBe(false);
    expect(guards.isAllowedS3Key({})).toBe(false);

    expect(guards.normaliseS3Folder('planning-docs/')).toBe('planning-docs');
    expect(guards.normaliseS3Folder('other')).toBeNull();

    expect(guards.isSafeProjectId('397708')).toBe(true);
    expect(guards.isSafeProjectId(397708)).toBe(true);
    expect(guards.isSafeProjectId('../x')).toBe(false);
    expect(guards.isSafeProjectId('a/b')).toBe(false);
    expect(guards.isSafeProjectId('')).toBe(false);
    expect(guards.isSafeProjectId({ $gt: '' })).toBe(false);
  });
});

// --- startup checks --------------------------------------------------------------------

describe('assertJwtSecret', () => {
  const { assertJwtSecret } = require('../../utils/startupChecks');

  test('production refuses a missing or short secret and never echoes it', () => {
    expect(() => assertJwtSecret({ NODE_ENV: 'production' })).toThrow(/not set/);
    let message = '';
    try { assertJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'short-secret' }); } catch (e) { message = e.message; }
    expect(message).toMatch(/too short/);
    expect(message).not.toMatch(/short-secret/);
    expect(() => assertJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'k7Qz'.repeat(8) })).not.toThrow();
  });

  test('the placeholders shipped in the example files and docs are refused', () => {
    const shipped = [
      'your-64-character-jwt-secret-here',
      'your-super-secret-jwt-key-change-this-in-production',
      'change-me-change-me-change-me-change-me'
    ];
    for (const value of shipped) {
      expect(value.length).toBeGreaterThanOrEqual(32);
      expect(() => assertJwtSecret({ NODE_ENV: 'production', JWT_SECRET: value })).toThrow(/placeholder/);
    }
  });

  test('an unset or misspelt NODE_ENV is treated as production', () => {
    expect(() => assertJwtSecret({})).toThrow(/not set/);
    expect(() => assertJwtSecret({ NODE_ENV: 'Production', JWT_SECRET: 'short' })).toThrow(/too short/);
  });

  test('tests and local development are left alone', () => {
    expect(() => assertJwtSecret({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertJwtSecret({ NODE_ENV: 'development' })).not.toThrow();
  });
});

// --- credentials in logs ---------------------------------------------------------------

describe('buildingInfoService.redactUrl', () => {
  test('strips both credentials and leaves the rest of the URL readable', () => {
    const service = jest.requireActual('../../services/buildingInfoService');
    const redacted = service.redactUrl('https://api.example.com/x?api_key=SECRETKEY&ukey=SECRETUKEY&planning_id=397708&more=limit 0,1000');
    expect(redacted).not.toMatch(/SECRETKEY|SECRETUKEY/);
    expect(redacted).toContain('planning_id=397708');
    expect(redacted).toContain('api_key=***');
    expect(redacted).toContain('ukey=***');
  });
});
