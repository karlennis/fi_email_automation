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

    it('prefers the production directory whenever it exists, regardless of what is in it', () => {
      // Not "whichever directory has the freshest logs". That heuristic failed on the
      // box: maintenance scripts run from a login shell require the logger without
      // NODE_ENV, which writes a brand-new backend/logs/app-DATE.log containing only
      // their own startup lines. Freshness then chose that file and the reader reported
      // "no runs found" while the night sat in /var/log/fi_email.
      const spy = jest.spyOn(fs, 'existsSync').mockImplementation(
        (p) => p === logPaths.PRODUCTION_LOG_DIR
      );
      try {
        expect(logPaths.readDir()).toBe(logPaths.PRODUCTION_LOG_DIR);
      } finally {
        spy.mockRestore();
      }
    });

    it('falls back to the development directory when the production one is absent', () => {
      const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      try {
        expect(logPaths.readDir()).toBe(logPaths.DEVELOPMENT_LOG_DIR);
      } finally {
        spy.mockRestore();
      }
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
