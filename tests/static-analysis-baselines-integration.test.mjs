import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../scripts/check-static-analysis-baselines.mjs', import.meta.url));
const canonicalPhpstanBaseline = `parameters:
  ignoreErrors:
    -
      message: '#^Known message$#'
      identifier: argument.type
      count: 2
      path: includes/file.php
`;

function writeFixtureFile(root, path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function createRepository(files) {
  const root = mkdtempSync(join(tmpdir(), 'static-baseline-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });

  for (const [path, contents] of Object.entries(files)) {
    writeFixtureFile(root, path, contents);
  }

  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture'],
    { cwd: root },
  );

  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { revision, root };
}

function runChecker(root, revision) {
  return spawnSync(process.execPath, [checker, revision], {
    cwd: root,
    encoding: 'utf8',
  });
}

function phpstanRepository() {
  return createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpstan: 'phpstan analyse --no-progress' } }, null, 2)}\n`,
    'phpstan-baseline.neon': canonicalPhpstanBaseline,
    'phpstan.neon.dist': `includes:
  - phpstan-baseline.neon

parameters:
  paths:
    - includes
`,
  });
}

test('complete baseline check rejects every noncanonical PHPStan bypass', (t) => {
  const fixture = phpstanRepository();
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  assert.equal(runChecker(fixture.root, fixture.revision).status, 0);

  const bypasses = [
    `parameters:
  ignoreErrors:
    -
      message: '#^Known message$#'
      path: includes/file.php
`,
    `parameters:
  ignoreErrors:
    -
      message: '#^Known message$#'
      count: 0
      path: includes/file.php
`,
    "parameters:\n  ignoreErrors: [ '#.*#' ]\n",
    "includes:\n  - permissive.neon\n",
    `${canonicalPhpstanBaseline}includes:\n  - permissive.neon\n`,
    `${canonicalPhpstanBaseline}parameters:\n  ignoreErrors:\n    - '#.*#'\n`,
  ];

  for (const source of bypasses) {
    writeFixtureFile(fixture.root, 'phpstan-baseline.neon', source);
    const result = runChecker(fixture.root, fixture.revision);
    assert.equal(result.status, 2, result.stderr);
  }
});

test('existing baseline protects its Composer analyzer command', (t) => {
  const fixture = phpstanRepository();
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'composer.json', '{"scripts":{"phpstan":"true"}}\n');
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Composer script phpstan must exist and remain unchanged/u);
});

test('existing baseline protects conventional analyzer configurations', (t) => {
  const fixture = phpstanRepository();
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpstan.neon', "parameters:\n  paths: []\n");
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /may not add, remove, or change phpstan\.neon/u);
});

test('existing baseline protects a directly named repository runner', (t) => {
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': '<ruleset name="Fixture"/>\n',
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'scripts/check-phpcs-baseline.php', "<?php\necho 'skipped';\n");
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /may not add, remove, or change scripts\/check-phpcs-baseline\.php/u);
});

test('existing baseline protects runners adjacent to shell control delimiters', (t) => {
  for (const command of [
    'php scripts/check-phpcs-baseline.php; echo complete',
    'php scripts/check-phpcs-baseline.php&&echo complete',
    'php scripts/check-phpcs-baseline.php||echo failed',
  ]) {
    const fixture = createRepository({
      'composer.json': `${JSON.stringify({ scripts: { phpcs: command } }, null, 2)}\n`,
      'phpcs-baseline.json': '{}\n',
      'phpcs.xml.dist': '<ruleset name="Fixture"/>\n',
      'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
    });
    t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

    writeFixtureFile(fixture.root, 'scripts/check-phpcs-baseline.php', "<?php\necho 'skipped';\n");
    const result = runChecker(fixture.root, fixture.revision);
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /may not add, remove, or change scripts\/check-phpcs-baseline\.php/u);
  }
});

test('runner parsing rejects unsupported punctuation and path normalization instead of skipping them', (t) => {
  for (const path of ['scripts/check.php,', 'scripts/../scripts/check.php', 'scripts//check.php']) {
    const fixture = createRepository({
      'composer.json': `${JSON.stringify({ scripts: { phpcs: `php ${path}` } }, null, 2)}\n`,
      'phpcs-baseline.json': '{}\n',
      'phpcs.xml.dist': '<ruleset name="Fixture"/>\n',
    });
    t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

    const result = runChecker(fixture.root, fixture.revision);
    assert.equal(result.status, 2, `${path}: ${result.stderr}`);
    assert.match(result.stderr, /Unsupported local runner reference/u);
  }
});

test('existing baseline protects an extensionless repository runner', (t) => {
  const fixture = createRepository({
    'bin/phpstan': "#!/bin/sh\necho checked\n",
    'composer.json': `${JSON.stringify({ scripts: { phpstan: 'bin/phpstan' } }, null, 2)}\n`,
    'phpstan-baseline.neon': canonicalPhpstanBaseline,
    'phpstan.neon.dist': "includes:\n  - phpstan-baseline.neon\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'bin/phpstan', "#!/bin/sh\necho skipped\n");
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /may not add, remove, or change bin\/phpstan/u);
});

test('existing baseline protects Composer script aliases transitively', (t) => {
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpstan: '@analyse', analyse: 'phpstan analyse --no-progress' } }, null, 2)}\n`,
    'phpstan-baseline.neon': canonicalPhpstanBaseline,
    'phpstan.neon.dist': "includes:\n  - phpstan-baseline.neon\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(
    fixture.root,
    'composer.json',
    `${JSON.stringify({ scripts: { phpstan: '@analyse', analyse: 'true' } }, null, 2)}\n`,
  );
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Composer script analyse must exist and remain unchanged/u);
});

test('initial baseline introduction requires a valid head analyzer contract', (t) => {
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpstan: 'phpstan analyse --no-progress' } }, null, 2)}\n`,
    'phpstan.neon.dist': "includes:\n  - phpstan-baseline.neon\n\nparameters:\n  paths:\n    - includes\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpstan-baseline.neon', canonicalPhpstanBaseline);
  assert.equal(runChecker(fixture.root, fixture.revision).status, 0);

  writeFixtureFile(fixture.root, 'composer.json', '{"scripts":{}}\n');
  let result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Composer script phpstan must exist/u);

  writeFixtureFile(fixture.root, 'composer.json', '{"scripts":{"phpstan":"true"}}\n');
  result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not directly reference the analyzer/u);

  writeFixtureFile(fixture.root, 'composer.json', '{"scripts":{"phpstan":"echo phpstan"}}\n');
  result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not directly reference the analyzer/u);

  writeFixtureFile(fixture.root, 'composer.json', '{"scripts":{"phpstan":"true || phpstan analyse"}}\n');
  result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not directly reference the analyzer/u);

  writeFixtureFile(fixture.root, 'composer.json', `${JSON.stringify({ scripts: { phpstan: 'phpstan analyse --no-progress' } })}\n`);
  writeFixtureFile(fixture.root, 'phpstan.neon.dist', "parameters:\n  paths:\n    - includes\n");
  result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no conventional configuration or direct runner references/u);

  unlinkSync(join(fixture.root, 'phpstan.neon.dist'));
  result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /head revision has no conventional phpstan configuration/u);
});

test('initial PHPCS baseline accepts an explicit new runner bound to the locked analyzer', (t) => {
  const fixture = createRepository({ 'README.md': 'Fixture\n' });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'composer.json', `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } })}\n`);
  writeFixtureFile(fixture.root, 'phpcs-baseline.json', '{}\n');
  writeFixtureFile(fixture.root, 'phpcs.xml.dist', '<ruleset name="Fixture"/>\n');
  writeFixtureFile(fixture.root, 'scripts/check-phpcs-baseline.php', "<?php\n$baseline = 'phpcs-baseline.json';\n$binary = 'vendor/bin/phpcs';\n");

  assert.equal(runChecker(fixture.root, fixture.revision).status, 0);

  unlinkSync(join(fixture.root, 'scripts/check-phpcs-baseline.php'));
  const result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /references missing head runner/u);
});
