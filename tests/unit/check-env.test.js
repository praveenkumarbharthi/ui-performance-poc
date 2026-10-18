'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const checkEnv = require('../../scripts/check-env');

test('parseMin extracts a >= requirement', () => {
  assert.deepEqual(checkEnv.parseMin('>=22.19.0'), { major: 22, minor: 19, patch: 0 });
});

test('parseMin returns null for an unparseable requirement', () => {
  assert.equal(checkEnv.parseMin('^22'), null);
});

test('parseVersion extracts a concrete version', () => {
  assert.deepEqual(checkEnv.parseVersion('24.18.0'), { major: 24, minor: 18, patch: 0 });
});

test('compare orders versions correctly', () => {
  const a = { major: 22, minor: 19, patch: 0 };
  const b = { major: 22, minor: 18, patch: 9 };
  assert.ok(checkEnv.compare(a, b) > 0);
  assert.ok(checkEnv.compare(b, a) < 0);
  assert.equal(checkEnv.compare(a, { ...a }), 0);
});
