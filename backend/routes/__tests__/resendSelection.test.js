/**
 * Tests for selectProjectsForResend (audit item 21).
 *
 * The resend modal renders one card per projectsFound entry but sent back only the
 * project IDs of the ticked ones. A report routinely holds several entries for the same
 * project - the same FI text republished across a planner report and an environment
 * report - so unticking one of two entries for project 404436 still sent both: the ID
 * survived in the list and the filter re-admitted every entry carrying it. The UI
 * promised one match and the customer received two. The selection was unrepresentable.
 *
 * The helper is pure, so this needs no express, no supertest and no mongo.
 */

const { selectProjectsForResend } = require('../reports');

/** Two entries for one project, one for another - the shape that caused the bug. */
function projectsFound() {
  return [
    { _id: 'a1', projectId: '404436', metadata: { documentName: 'Planner-Report--1-.pdf' } },
    { _id: 'a2', projectId: '404436', metadata: { documentName: 'Environment-Report--1-.pdf' } },
    { _id: 'b1', projectId: '389003', metadata: { documentName: 'FI-Request.pdf' } }
  ];
}

describe('selectProjectsForResend', () => {
  test('selects exactly one of two entries sharing a project', () => {
    // The whole point of item 21. Under the old projectId filter this returned both.
    const selected = selectProjectsForResend(projectsFound(), { includedMatchIds: ['a1'] });

    expect(selected).toHaveLength(1);
    expect(selected[0]._id).toBe('a1');
    expect(selected[0].metadata.documentName).toBe('Planner-Report--1-.pdf');
  });

  test('selects across projects', () => {
    const selected = selectProjectsForResend(projectsFound(), { includedMatchIds: ['a2', 'b1'] });

    expect(selected.map(p => p._id)).toEqual(['a2', 'b1']);
  });

  test('compares ids as strings, since ObjectIds arrive as objects', () => {
    const entries = [{ _id: { toString: () => 'a1' }, projectId: '404436' }];

    expect(selectProjectsForResend(entries, { includedMatchIds: ['a1'] })).toHaveLength(1);
  });

  test('includedMatchIds wins when a client sends both', () => {
    // The frontend sends both for backward compatibility; the precise one must win or
    // the fix would do nothing.
    const selected = selectProjectsForResend(projectsFound(), {
      includedMatchIds: ['a1'],
      includedProjectIds: ['404436']
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]._id).toBe('a1');
  });

  test('falls back to includedProjectIds for a client that predates match ids', () => {
    // Documented legacy behaviour: still coarse, still selects both entries.
    const selected = selectProjectsForResend(projectsFound(), { includedProjectIds: ['404436'] });

    expect(selected).toHaveLength(2);
    expect(selected.every(p => p.projectId === '404436')).toBe(true);
  });

  test('returns everything when no selection is supplied', () => {
    expect(selectProjectsForResend(projectsFound(), {})).toHaveLength(3);
    expect(selectProjectsForResend(projectsFound())).toHaveLength(3);
  });

  test('an empty array is treated as "no selection", not "select nothing"', () => {
    // Matches the previous behaviour, and the route rejects a genuinely empty tick list
    // before it ever reaches here.
    expect(selectProjectsForResend(projectsFound(), { includedMatchIds: [] })).toHaveLength(3);
  });

  test('unknown ids select nothing, so the route can return a stale-selection 400', () => {
    const selected = selectProjectsForResend(projectsFound(), { includedMatchIds: ['gone'] });

    expect(selected).toHaveLength(0);
  });

  test('tolerates a missing projectsFound', () => {
    expect(selectProjectsForResend(undefined, { includedMatchIds: ['a1'] })).toEqual([]);
    expect(selectProjectsForResend(null, {})).toEqual([]);
  });

  test('preserves order, which the audit export numbers matches by', () => {
    const selected = selectProjectsForResend(projectsFound(), { includedMatchIds: ['b1', 'a1'] });

    expect(selected.map(p => p._id)).toEqual(['a1', 'b1']);
  });
});
