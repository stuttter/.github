import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeAudit } from '../scripts/audit-wordpress-runtime.mjs';

test('accepts a complete audit with no vulnerabilities', () => {
  const report = {
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  };
  assert.deepEqual(validateRuntimeAudit(report), []);
});

test('rejects every reported vulnerable package', () => {
  const report = {
    vulnerabilities: {
      'example-package': { severity: 'moderate', via: [] },
      'transitive-package': { severity: 'high', via: ['example-package'] },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 } },
  };
  assert.deepEqual(
    validateRuntimeAudit(report),
    ['npm audit reported vulnerable packages: example-package, transitive-package.'],
  );
});

test('rejects incomplete audit reports', () => {
  for (const report of [null, {}, { vulnerabilities: {} }, { vulnerabilities: {}, metadata: { vulnerabilities: {} } }]) {
    assert.deepEqual(validateRuntimeAudit(report), ['npm audit did not return a complete vulnerability report.']);
  }
});
