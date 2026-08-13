const runContext = require('../runContext');

describe('runContext', () => {
  it('returns an empty context outside a run', () => {
    expect(runContext.getContext()).toEqual({});
    expect(runContext.getRunId()).toBeUndefined();
  });

  it('carries fields across await', async () => {
    await runContext.runWith({ runId: 'SCAN-1' }, async () => {
      expect(runContext.getRunId()).toBe('SCAN-1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(runContext.getRunId()).toBe('SCAN-1');
    });
  });

  it('carries fields into setTimeout and callback boundaries', async () => {
    const seen = await runContext.runWith({ runId: 'SCAN-2' }, () =>
      new Promise((resolve) => {
        setTimeout(() => {
          process.nextTick(() => resolve(runContext.getRunId()));
        }, 1);
      })
    );

    expect(seen).toBe('SCAN-2');
  });

  it('keeps concurrent runs separate', async () => {
    // The failure this guards against is one run's id leaking onto another run's lines,
    // which would make --run filtering silently wrong rather than obviously broken.
    const run = (id, delay) =>
      runContext.runWith({ runId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return runContext.getRunId();
      });

    const results = await Promise.all([run('A', 20), run('B', 1), run('C', 10)]);

    expect(results).toEqual(['A', 'B', 'C']);
    expect(runContext.getRunId()).toBeUndefined();
  });

  it('merges nested runs rather than replacing the parent context', async () => {
    await runContext.runWith({ runId: 'SCAN-3', job: 'SCAN-1042' }, async () => {
      await runContext.runWith({ file: 'a.pdf' }, async () => {
        expect(runContext.getContext()).toEqual({
          runId: 'SCAN-3',
          job: 'SCAN-1042',
          file: 'a.pdf'
        });
      });

      // The inner fields must not survive back into the parent.
      expect(runContext.getContext()).toEqual({ runId: 'SCAN-3', job: 'SCAN-1042' });
    });
  });

  it('addContext adds to the active run and is a no-op outside one', async () => {
    await runContext.runWith({ runId: 'SCAN-4' }, async () => {
      runContext.addContext({ target: '2026-08-12' });
      expect(runContext.getContext()).toEqual({ runId: 'SCAN-4', target: '2026-08-12' });
    });

    expect(() => runContext.addContext({ target: 'x' })).not.toThrow();
    expect(runContext.getContext()).toEqual({});
  });

  it('mints greppable, date-stamped ids', () => {
    const id = runContext.newRunId('SCAN', new Date(2026, 7, 13));

    expect(id).toMatch(/^SCAN-20260813-[a-z0-9]{4}$/);
    expect(runContext.newRunId('SCAN')).not.toBe(runContext.newRunId('SCAN'));
  });
});
