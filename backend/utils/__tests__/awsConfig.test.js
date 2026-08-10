/**
 * Tests for backend/utils/awsConfig.js
 *
 * Regression cover for the split-brain scan: fastS3Scanner read S3_BUCKET_NAME while
 * scanJobProcessor read S3_BUCKET, and both fell back to the same literal, so the
 * mismatch only appeared once someone set the documented variable. Every download then
 * 404'd against a bucket the scanner had never listed, and the night still reported
 * success. The region had the same shape: the scanner defaulted to eu-west-2 while
 * everything else used eu-north-1.
 *
 * getBucket/getRegion take an injectable env so these run without touching process.env.
 */

const {
  getBucket,
  getRegion,
  assertConsistentS3Env,
  DEFAULT_BUCKET,
  DEFAULT_REGION
} = require('../awsConfig');

describe('getBucket', () => {
  test('prefers S3_BUCKET over the legacy aliases', () => {
    expect(getBucket({
      S3_BUCKET: 'canonical',
      S3_BUCKET_NAME: 'legacy',
      AWS_S3_BUCKET_NAME: 'older'
    })).toBe('canonical');
  });

  test('falls back through S3_BUCKET_NAME then AWS_S3_BUCKET_NAME', () => {
    expect(getBucket({ S3_BUCKET_NAME: 'legacy', AWS_S3_BUCKET_NAME: 'older' })).toBe('legacy');
    expect(getBucket({ AWS_S3_BUCKET_NAME: 'older' })).toBe('older');
  });

  test('defaults when nothing is set', () => {
    expect(getBucket({})).toBe(DEFAULT_BUCKET);
    expect(DEFAULT_BUCKET).toBe('planning-documents-2');
  });

  test('treats empty and whitespace-only values as unset', () => {
    expect(getBucket({ S3_BUCKET: '', S3_BUCKET_NAME: 'legacy' })).toBe('legacy');
    expect(getBucket({ S3_BUCKET: '   ' })).toBe(DEFAULT_BUCKET);
  });

  test('trims surrounding whitespace', () => {
    expect(getBucket({ S3_BUCKET: '  spaced  ' })).toBe('spaced');
  });
});

describe('getRegion', () => {
  test('prefers AWS_REGION over S3_REGION', () => {
    expect(getRegion({ AWS_REGION: 'eu-north-1', S3_REGION: 'eu-west-2' })).toBe('eu-north-1');
  });

  test('falls back to S3_REGION', () => {
    expect(getRegion({ S3_REGION: 'eu-west-1' })).toBe('eu-west-1');
  });

  test('defaults to eu-north-1, not the scanner old eu-west-2', () => {
    expect(getRegion({})).toBe('eu-north-1');
    expect(DEFAULT_REGION).toBe('eu-north-1');
  });
});

describe('assertConsistentS3Env', () => {
  test('passes when only the canonical variables are set', () => {
    expect(() => assertConsistentS3Env({ S3_BUCKET: 'b', AWS_REGION: 'r' })).not.toThrow();
  });

  test('passes when aliases are set to the SAME value', () => {
    expect(() => assertConsistentS3Env({
      S3_BUCKET: 'b',
      S3_BUCKET_NAME: 'b',
      AWS_REGION: 'eu-north-1',
      S3_REGION: 'eu-north-1'
    })).not.toThrow();
  });

  test('passes on an empty environment (both settings fall through to defaults)', () => {
    expect(() => assertConsistentS3Env({})).not.toThrow();
  });

  test('throws when two bucket spellings disagree', () => {
    expect(() => assertConsistentS3Env({ S3_BUCKET: 'a', S3_BUCKET_NAME: 'b' }))
      .toThrow(/conflicting bucket configuration/);
  });

  test('throws when two region spellings disagree', () => {
    expect(() => assertConsistentS3Env({ AWS_REGION: 'eu-north-1', S3_REGION: 'eu-west-2' }))
      .toThrow(/conflicting region configuration/);
  });

  test('names both offending variables so the operator can tell which to change', () => {
    expect(() => assertConsistentS3Env({ S3_BUCKET: 'a', AWS_S3_BUCKET_NAME: 'b' }))
      .toThrow(/S3_BUCKET=a.*AWS_S3_BUCKET_NAME=b/);
  });

  test('reports the resolved pair when consistent', () => {
    expect(assertConsistentS3Env({ S3_BUCKET: 'b', S3_REGION: 'eu-west-1' }))
      .toEqual({ bucket: 'b', region: 'eu-west-1' });
  });
});
