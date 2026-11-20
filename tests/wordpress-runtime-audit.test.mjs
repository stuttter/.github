import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeAudit, validateRuntimeCompatibility, validateRuntimeContract } from '../scripts/audit-wordpress-runtime.mjs';

function runtimeFixture() {
  return {
    lock: {
      packages: {
        'node_modules/@simple-git/argv-parser': { version: '2.0.1' },
        'node_modules/@wordpress/env': { version: '11.16.0' },
        'node_modules/body-parser': { version: '1.20.9' },
        'node_modules/got': { version: '11.8.6' },
        'node_modules/cacheable-request': { version: '7.0.4' },
        'node_modules/express': { version: '4.22.3' },
        'node_modules/fast-xml-parser': { version: '5.12.0' },
        'node_modules/fast-uri': { version: '3.1.9' },
        'node_modules/glob': { version: '14.0.3' },
        'node_modules/http-cache-semantics': { version: '4.3.0' },
        'node_modules/js-yaml': { version: '4.3.2' },
        'node_modules/minimatch': { version: '11.0.3' },
        'node_modules/proxy-addr': { version: '2.0.8' },
        'node_modules/qs': { version: '6.17.1' },
        'node_modules/rimraf': { version: '6.1.3' },
        'node_modules/simple-git': { version: '4.0.2' },
      },
    },
    sources: {
      'wordpress.js': "const got = require('got');\nconst versions = await got('https://api.wordpress.org/').json();",
      'download-sources.js': "const got = require('got');\nconst { rimraf } = require( 'rimraf' );\nconst { simpleGit: SimpleGit } = require( 'simple-git' );\nconst responseStream = got.stream(source.url);",
      'config/parse-config.js': 'module.exports = {};',
      'commands/start.js': "const { rimraf } = require( 'rimraf' );",
      'runtime/docker/index.js': "const { rimraf } = require( 'rimraf' );",
      'runtime/docker/download-wp-phpunit.js': "const { simpleGit: SimpleGit } = require( 'simple-git' );",
      'runtime/playground/index.js': "const { rimraf } = require( 'rimraf' );\nrequire.resolve( '@wp-playground/cli/package.json' );",
    },
  };
}

function playgroundAuditFixture() {
  return {
    report: {
      vulnerabilities: {
        '@wp-playground/blueprints': {
          name: '@wp-playground/blueprints',
          severity: 'moderate',
          isDirect: false,
          via: ['@wp-playground/storage'],
          effects: ['@wp-playground/cli', '@wp-playground/tools'],
          range: '1.0.5 || 3.0.16 || >=3.1.17',
          nodes: ['node_modules/@wp-playground/blueprints'],
          fixAvailable: true,
        },
        '@wp-playground/cli': {
          name: '@wp-playground/cli',
          severity: 'moderate',
          isDirect: false,
          via: ['@wp-playground/blueprints', '@wp-playground/storage', '@wp-playground/tools'],
          effects: [],
          range: '1.0.5 || 3.0.16 || 3.0.30 || >=3.1.17',
          nodes: ['node_modules/@wp-playground/cli'],
          fixAvailable: true,
        },
        '@wp-playground/storage': {
          name: '@wp-playground/storage',
          severity: 'moderate',
          isDirect: false,
          via: ['isomorphic-git'],
          effects: ['@wp-playground/blueprints', '@wp-playground/cli'],
          range: '>=3.1.28',
          nodes: ['node_modules/@wp-playground/storage'],
          fixAvailable: true,
        },
        '@wp-playground/tools': {
          name: '@wp-playground/tools',
          severity: 'moderate',
          isDirect: false,
          via: ['@wp-playground/blueprints'],
          effects: ['@wp-playground/cli'],
          range: '>=3.1.18',
          nodes: ['node_modules/@wp-playground/tools'],
          fixAvailable: true,
        },
        'isomorphic-git': {
          name: 'isomorphic-git',
          severity: 'high',
          isDirect: false,
          via: [
            {
              source: 1244996,
              name: 'isomorphic-git',
              dependency: 'isomorphic-git',
              url: 'https://github.com/advisories/GHSA-cw2g-2vwq-88w6',
              severity: 'moderate',
              range: '<=1.38.5',
            },
            {
              source: 1244997,
              name: 'isomorphic-git',
              dependency: 'isomorphic-git',
              url: 'https://github.com/advisories/GHSA-96wc-2m84-2cj7',
              severity: 'moderate',
              range: '<=1.38.5',
            },
            {
              source: 1244998,
              name: 'isomorphic-git',
              dependency: 'isomorphic-git',
              url: 'https://github.com/advisories/GHSA-9qw7-j9xw-fv9c',
              severity: 'high',
              range: '<=1.38.5',
            },
          ],
          effects: ['@wp-playground/storage'],
          range: '<=1.38.5',
          nodes: ['node_modules/@wp-playground/storage/node_modules/isomorphic-git'],
          fixAvailable: true,
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 4, high: 1, critical: 0, total: 5 },
      },
    },
    lock: {
      packages: {
        'node_modules/@wp-playground/storage': {
          version: '3.1.53',
          dependencies: { 'isomorphic-git': '1.37.6' },
        },
        'node_modules/@wp-playground/storage/node_modules/isomorphic-git': { version: '1.37.6' },
      },
    },
    runner: '"${wp_env}" start --update --runtime=docker --config="${config}"',
  };
}

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

test('accepts only the reviewed inactive Playground advisory graph', () => {
  const fixture = playgroundAuditFixture();
  assert.deepEqual(validateRuntimeAudit(fixture.report, fixture.lock, fixture.runner), []);
});

test('rejects Playground advisory, package-path, or runtime drift', () => {
  const advisory = playgroundAuditFixture();
  advisory.report.vulnerabilities['isomorphic-git'].via[0].source += 1;
  assert.match(validateRuntimeAudit(advisory.report, advisory.lock, advisory.runner).join('\n'), /vulnerable packages/u);

  const packagePath = playgroundAuditFixture();
  packagePath.lock.packages['node_modules/isomorphic-git'] = { version: '1.37.6' };
  assert.match(validateRuntimeAudit(packagePath.report, packagePath.lock, packagePath.runner).join('\n'), /vulnerable packages/u);

  const runtime = playgroundAuditFixture();
  runtime.runner = runtime.runner.replace('--runtime=docker', '--runtime=playground');
  assert.match(validateRuntimeAudit(runtime.report, runtime.lock, runtime.runner).join('\n'), /vulnerable packages/u);
});

test('accepts only the reviewed uncached wp-env runtime contract', () => {
  const { lock, sources } = runtimeFixture();
  assert.deepEqual(validateRuntimeContract(lock, sources), []);
});

test('rejects runtime version or request-path drift', () => {
  const { lock, sources } = runtimeFixture();
  lock.packages['node_modules/http-cache-semantics'].version = '4.4.0';
  sources['download-sources.js'] += '\nconst options = { cache: store };';
  const errors = validateRuntimeContract(lock, sources);
  assert.match(errors.join('\n'), /http-cache-semantics is not locked/u);
  assert.match(errors.join('\n'), /uncached got request paths/u);
});

test('rejects a missing or legacy simple-git compatibility import', () => {
  const { lock, sources } = runtimeFixture();
  sources['download-sources.js'] = sources['download-sources.js'].replace(
    "const { simpleGit: SimpleGit } = require( 'simple-git' );",
    "const SimpleGit = require( 'simple-git' );",
  );
  const errors = validateRuntimeContract(lock, sources);
  assert.match(errors.join('\n'), /simple-git 4 compatibility patch/u);
});

test('rejects nested overrides of reviewed runtime packages', () => {
  const { lock, sources } = runtimeFixture();
  lock.packages['node_modules/@wordpress/env/node_modules/got'] = { version: '11.8.5' };
  const errors = validateRuntimeContract(lock, sources);
  assert.match(errors.join('\n'), /got must be installed only at its reviewed top-level lockfile path/u);
});

test('rejects a missing runtime lockfile without throwing', () => {
  const { sources } = runtimeFixture();
  assert.doesNotThrow(() => validateRuntimeContract(undefined, sources));
  assert.match(
    validateRuntimeContract(undefined, sources).join('\n'),
    /@wordpress\/env must be installed only at its reviewed top-level lockfile path/u,
  );
});

test('rejects legacy rimraf imports', () => {
  const { lock, sources } = runtimeFixture();
  sources['commands/start.js'] = "const rimraf = require( 'rimraf' );";
  assert.match(
    validateRuntimeContract(lock, sources).join('\n'),
    /rimraf 6 named asynchronous API/u,
  );
});

test('rejects a Playground dependency reference outside the inactive runtime', () => {
  const { lock, sources } = runtimeFixture();
  sources['runtime/docker/index.js'] += "\nrequire( '@wp-playground/storage' );";
  assert.match(
    validateRuntimeContract(lock, sources).join('\n'),
    /isolates Playground dependencies/u,
  );
});

test('runtime compatibility smoke fails closed without the reviewed packages', () => {
  assert.match(
    validateRuntimeCompatibility(process.cwd()).join('\n'),
    /runtime compatibility smoke failed/u,
  );
});
