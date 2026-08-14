const fs = require('fs');
const os = require('os');
const path = require('path');

const logPaths = require('../logPaths');

describe('logPaths', () => {
  const originalEnv = { ...process.env };
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logpaths-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('has no side effects - requiring it creates nothing', () => {
    // The whole reason this module exists. scripts/logs.js used to require utils/logger
    // just to ask for a path; that built the transports, which created the log directory
    // and empty dated files. On the box that meant a read-only command wrote files into
    // backend/logs and then chose to read from there.
    const before = fs.readdirSync(tmp).length;
    jest.resetModules();
    require('../logPaths');
    expect(fs.readdirSync(tmp).length).toBe(before);
  });

  describe('writeDir', () => {
    it('honours LOG_DIR above everything', () => {
      process.env.LOG_DIR = tmp;
      process.env.NODE_ENV = 'production';
      expect(logPaths.writeDir()).toBe(tmp);
    });

    it('uses the production directory only when NODE_ENV says so', () => {
      delete process.env.LOG_DIR;

      process.env.NODE_ENV = 'production';
      expect(logPaths.writeDir()).toBe(logPaths.PRODUCTION_LOG_DIR);

      process.env.NODE_ENV = 'development';
      expect(logPaths.writeDir()).toBe(logPaths.DEVELOPMENT_LOG_DIR);
    });
  });

  describe('readDir', () => {
    beforeEach(() => {
      delete process.env.LOG_DIR;
      delete process.env.NODE_ENV;
    });

    it('honours an explicit directory', () => {
      expect(logPaths.readDir(tmp)).toBe(tmp);
    });

    it('honours LOG_DIR when no directory is given', () => {
      process.env.LOG_DIR = tmp;
      expect(logPaths.readDir()).toBe(tmp);
    });

    it('ranks a directory by its freshest dated log, which is how the live one is chosen', () => {
      // A login shell has no NODE_ENV, so the reader cannot infer which directory the
      // running apps write to. Both candidates can hold dated files - one live, one left
      // over - and choosing by list order picked the stale one on the box.
      const stale = path.join(tmp, 'stale');
      const live = path.join(tmp, 'live');
      fs.mkdirSync(stale);
      fs.mkdirSync(live);

      fs.writeFileSync(path.join(stale, 'app-2026-08-14.log'), '');
      fs.writeFileSync(path.join(live, 'app-2026-08-14.log'), '{}\n');

      const yesterday = new Date(Date.now() - 86400000);
      fs.utimesSync(path.join(stale, 'app-2026-08-14.log'), yesterday, yesterday);

      expect(logPaths.datedLogFreshness(live))
        .toBeGreaterThan(logPaths.datedLogFreshness(stale));
    });

    it('scores a directory with no dated logs as zero, so it never wins', () => {
      const empty = path.join(tmp, 'empty');
      fs.mkdirSync(empty);
      // The old size-rotated files and PM2's captures must not count as a day.
      fs.writeFileSync(path.join(empty, 'combined1.log'), 'x');
      fs.writeFileSync(path.join(empty, 'app.log'), 'x');

      expect(logPaths.datedLogFreshness(empty)).toBe(0);
      expect(logPaths.datedLogFreshness(path.join(tmp, 'does-not-exist'))).toBe(0);
    });

    it('matches the dated filenames the logger actually writes, including size suffixes', () => {
      expect(logPaths.DATED_LOG_RE.test('app-2026-08-14.log')).toBe(true);
      expect(logPaths.DATED_LOG_RE.test('debug-2026-08-14.log.1')).toBe(true);
      expect(logPaths.DATED_LOG_RE.test('error-2026-08-14.log')).toBe(true);

      // The undated fallback names must NOT match - otherwise diskCleanupService would
      // apply date-based retention to them and the reader would treat them as a day.
      expect(logPaths.DATED_LOG_RE.test('app.log')).toBe(false);
      expect(logPaths.DATED_LOG_RE.test('backend-out.log')).toBe(false);
      expect(logPaths.DATED_LOG_RE.test('combined1.log')).toBe(false);
    });
  });
});
