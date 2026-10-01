/**
 * The one place API routers are mounted.
 *
 * Until this file existed server.js mounted fourteen routers with app.use() and left
 * authentication to each route file. Nine of them had none, so most of the API -
 * including routes that browsed the server's filesystem - answered anyone who could reach
 * nginx. Protection that has to be remembered per file is protection that gets forgotten.
 *
 * Here the default is the other way round: every router gets `authenticate` at mount
 * time, and a router can only be public by being named in PUBLIC_PATHS. Adding a line to
 * ROUTE_TABLE without an access level throws at startup rather than mounting it open.
 *
 * Access levels:
 *   public         no middleware; the router guards its own routes (auth only - login has
 *                  to be reachable without a token)
 *   authenticated  a valid token for an active @buildinginfo.com user
 *   admin          as above, and role === 'admin'
 *
 * Routers the frontend never calls (documents, jobs, scheduled-jobs, runs) are admin: they
 * trigger scans, spend on OpenAI, or send email, and nobody but an administrator with a
 * token in hand has a reason to reach them.
 *
 * Finer-grained rules (one admin-only route inside an authenticated router) stay in the
 * route file, on the route.
 */

const { authenticate, requireAdmin } = require('../middleware/auth');

const ACCESS_LEVELS = ['public', 'authenticated', 'admin'];

// The only routers allowed to be mounted without authenticate.
const PUBLIC_PATHS = ['/api/auth'];

// `load` is a thunk so the table can be read (by the tests, for one) without requiring
// every route file and the services behind it.
const ROUTE_TABLE = [
  { path: '/api/auth', access: 'public', load: () => require('./auth') },
  { path: '/api/projects', access: 'authenticated', load: () => require('./projects') },
  { path: '/api/documents', access: 'admin', load: () => require('./documents') },
  { path: '/api/documents-browser', access: 'admin', load: () => require('./documents-browser') },
  { path: '/api/customers', access: 'authenticated', load: () => require('./customers') },
  { path: '/api/jobs', access: 'admin', load: () => require('./jobs') },
  { path: '/api/scheduled-jobs', access: 'admin', load: () => require('./scheduled-jobs') },
  { path: '/api/filtering', access: 'authenticated', load: () => require('./api-filtering') },
  { path: '/api/test', access: 'admin', load: () => require('./test') },
  { path: '/api/reports', access: 'authenticated', load: () => require('./reports') },
  { path: '/api/document-register', access: 'authenticated', load: () => require('./document-register') },
  { path: '/api/register-fi', access: 'authenticated', load: () => require('./register-fi') },
  { path: '/api/document-scan', access: 'authenticated', load: () => require('./document-scan') },
  { path: '/api/runs', access: 'admin', load: () => require('./runs') }
];

function guardsFor(route) {
  if (!ACCESS_LEVELS.includes(route.access)) {
    throw new Error(`Route ${route.path} has no valid access level (got ${JSON.stringify(route.access)}); use one of ${ACCESS_LEVELS.join(', ')}`);
  }

  if (route.access === 'public') {
    if (!PUBLIC_PATHS.includes(route.path)) {
      throw new Error(`Route ${route.path} is marked public but is not in PUBLIC_PATHS`);
    }
    return [];
  }

  return route.access === 'admin' ? [authenticate, requireAdmin] : [authenticate];
}

function mountRoutes(app, table = ROUTE_TABLE) {
  // Validate the whole table before mounting anything, so a bad entry cannot leave the
  // app half mounted.
  const mounts = table.map(route => ({ route, guards: guardsFor(route) }));

  for (const { route, guards } of mounts) {
    app.use(route.path, ...guards, route.load());
  }

  return app;
}

module.exports = {
  mountRoutes,
  ROUTE_TABLE,
  PUBLIC_PATHS
};
