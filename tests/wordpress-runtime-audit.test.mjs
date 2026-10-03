import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeAudit } from '../scripts/audit-wordpress-runtime.mjs';

function fixture() {
  return {
    report: {
      vulnerabilities: {
        '@wordpress/env': { severity: 'high', via: ['got'] },
        got: { severity: 'high', via: ['cacheable-request'] },
        'cacheable-request': { severity: 'high', via: ['http-cache-semantics'] },
        'http-cache-semantics': {
          severity: 'high',
          via: [{
            url: 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp',
            range: '<=4.2.0',
          }],
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 4, critical: 0, total: 4 },
      },
    },
    lock: {
      packages: {
        'node_modules/@wordpress/env': { version: '11.15.0' },
        'node_modules/got': { version: '11.8.6' },
        'node_modules/cacheable-request': { version: '7.0.4' },
        'node_modules/http-cache-semantics': { version: '4.2.0' },
      },
    },
    sources: {
      'wordpress.js': "const got = require('got');\nconst versions = await got('https://api.wordpress.org/').json();",
      'download-sources.js': "const got = require('got');\nconst responseStream = got.stream(source.url);",
      'config/parse-config.js': 'module.exports = {};',
    },
  };
}

test('accepts only the reviewed uncached wp-env advisory chain', () => {
  const { report, lock, sources } = fixture();
  assert.deepEqual(validateRuntimeAudit(report, lock, sources, Date.parse('2026-10-03T00:00:00Z')), []);
});

test('rejects another audit finding', () => {
  const { report, lock, sources } = fixture();
  report.vulnerabilities.other = { severity: 'moderate', via: [] };
  report.metadata.vulnerabilities.moderate = 1;
  report.metadata.vulnerabilities.total = 5;
  assert.match(validateRuntimeAudit(report, lock, sources, Date.parse('2026-10-03T00:00:00Z')).join('\n'), /Unexpected vulnerable packages/u);
});

test('rejects a cached request path or changed locked dependency', () => {
  const { report, lock, sources } = fixture();
  lock.packages['node_modules/got'].version = '12.0.0';
  sources['download-sources.js'] += '\nconst options = { cache: store };';
  const errors = validateRuntimeAudit(
    report,
    lock,
    sources,
    Date.parse('2026-10-03T00:00:00Z'),
  );
  assert.match(errors.join('\n'), /got is not locked/u);
  assert.match(errors.join('\n'), /uncached got request paths/u);
});

test('rejects another got call form or source file', () => {
  const { report, lock, sources } = fixture();
  sources['download-sources.js'] += '\nconst client = got.extend({ timeout: 1000 });';
  sources['config/parse-config.js'] = 'const response = got.get(url);';
  assert.match(
    validateRuntimeAudit(report, lock, sources, Date.parse('2026-10-03T00:00:00Z')).join('\n'),
    /uncached got request paths/u,
  );
});

test('expires the temporary applicability review', () => {
  const { report, lock, sources } = fixture();
  assert.match(validateRuntimeAudit(report, lock, sources, Date.parse('2026-11-03T00:00:00Z')).join('\n'), /has expired/u);
});
