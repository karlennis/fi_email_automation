const path = require('path');
const Transport = require('winston-transport');
const logger = require('../logger');
const runContext = require('../runContext');

describe('logger', () => {
  it('writes no files under NODE_ENV=test', () => {
    // jest.setup.js sets NODE_ENV=test. If this regresses, every test run appends to the
    // real backend/logs directory and the suite starts polluting production-shaped data.
    expect(process.env.NODE_ENV).toBe('test');

    const fileTransports = logger.transports.filter((t) => t.filename || t.dirname);
    expect(fileTransports).toEqual([]);
  });

  it('keeps the logger itself at debug so the debug transport can receive records', () => {
    // A transport never sees records below the logger's own level, so an 'info' logger
    // would silently produce an empty debug-DATE.log.
    expect(logger.level).toBe('debug');
  });

  it('exposes the log directory it actually writes to', () => {
    expect(path.isAbsolute(logger.logDir) || logger.logDir.length > 0).toBe(true);
  });

  it('offers both candidate directories so a login shell can find the production one', () => {
    // scripts/logs.js probes these. Without the production path it looked only in
    // backend/logs and reported "no log for today" while the day sat in /var/log/fi_email.
    expect(logger.logDirCandidates).toContain('/var/log/fi_email');
    expect(logger.logDirCandidates.length).toBe(2);
  });

  describe('when winston-daily-rotate-file is not installed', () => {
    // The incident this guards against: a deploy pulled the code without running
    // npm install, the unguarded require threw, and worker.js, server.js and
    // ingestion-worker.js all died at startup. PM2 exhausted max_restarts and left them
    // errored - the whole pipeline down because a log transport was missing.
    let degraded;

    beforeAll(() => {
      jest.resetModules();
      jest.doMock('winston-daily-rotate-file', () => {
        const error = new Error("Cannot find module 'winston-daily-rotate-file'");
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      });
      degraded = require('../logger');
    });

    afterAll(() => {
      jest.dontMock('winston-daily-rotate-file');
      jest.resetModules();
    });

    it('still loads instead of throwing', () => {
      expect(degraded).toBeDefined();
      expect(typeof degraded.info).toBe('function');
    });

    it('reports that rotation is unavailable', () => {
      expect(degraded.rotationAvailable).toBe(false);
      expect(logger.rotationAvailable).toBe(true);
    });

    it('still logs without throwing', () => {
      expect(() => degraded.info('scan: progress', { done: 500 })).not.toThrow();
    });
  });

  describe('formatLine', () => {
    const line = (info) => logger.formatLine(info, false);

    it('renders time, padded level, run id, message and key=value meta', () => {
      expect(line({
        timestamp: '2026-08-13 00:14:02',
        level: 'error',
        runId: 'SCAN-20260813-a4f1',
        message: 'doc: text extraction failed',
        file: 'a3f9.pdf',
        proj: 1188422
      })).toBe(
        '00:14:02 ERROR [SCAN-20260813-a4f1] doc: text extraction failed  file=a3f9.pdf proj=1188422'
      );
    });

    it('omits the run id when there is no active run', () => {
      expect(line({ timestamp: '2026-08-13 09:00:00', level: 'info', message: 'server started' }))
        .toBe('09:00:00 INFO  server started');
    });

    it('appends a stack on its own lines', () => {
      const rendered = line({
        timestamp: '2026-08-13 09:00:00',
        level: 'error',
        message: 'boom',
        stack: 'Error: boom\n    at somewhere'
      });

      expect(rendered).toContain('09:00:00 ERROR boom');
      expect(rendered).toContain('\nError: boom\n    at somewhere');
    });

    it('leaves object-valued meta out of the one-line tail', () => {
      // Nested objects are preserved in the JSON on disk; inlining them here would wrap
      // the line and defeat the point of one record per line.
      expect(line({
        timestamp: '2026-08-13 09:00:00',
        level: 'info',
        message: 'scan summary',
        processed: 3182,
        detail: { a: 1 }
      })).toBe('09:00:00 INFO  scan summary  processed=3182');
    });
  });

  it('stamps the active run id onto records without being passed it', () => {
    const written = [];

    class CaptureTransport extends Transport {
      log(info, next) {
        written.push(info);
        next();
      }
    }

    const capture = new CaptureTransport({ level: 'debug' });
    logger.add(capture);

    try {
      runContext.runWith({ runId: 'SCAN-20260813-zzzz', job: 'SCAN-1042' }, () => {
        logger.info('scan: progress', { done: 500 });
      });
    } finally {
      logger.remove(capture);
    }

    const entry = written.find((w) => w.message === 'scan: progress');
    expect(entry).toBeDefined();
    expect(entry.runId).toBe('SCAN-20260813-zzzz');
    expect(entry.job).toBe('SCAN-1042');
    expect(entry.done).toBe(500);
  });
});
