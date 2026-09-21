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

function runChecker(root, revision, ...options) {
  return spawnSync(process.execPath, [checker, revision, ...options], {
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

function phpstanRetirementRepository() {
  return createRepository({
    'composer.json': JSON.stringify({ scripts: { phpstan: 'phpstan analyse --no-progress' } }, null, 2) + '\n',
    'phpstan-baseline.neon': canonicalPhpstanBaseline,
    'phpstan.neon.dist': [
      'includes:',
      '    - phpstan-baseline.neon',
      '',
      'parameters:',
      '    level: 5',
      '    phpVersion: 70400',
      '    paths:',
      '        - includes',
      '',
    ].join('\n'),
  });
}

function retirePhpstanBaseline(fixture, { level = 7, path = 'includes', stub = true, ignoreErrors = false } = {}) {
  unlinkSync(join(fixture.root, 'phpstan-baseline.neon'));
  writeFixtureFile(fixture.root, 'phpstan.neon.dist', [
    'parameters:',
    '    level: ' + level,
    '    phpVersion: 70400',
    '    paths:',
    '        - ' + path,
    '    stubFiles:',
    '        - phpstan-wordpress-compat.stub',
    ...(ignoreErrors ? ['    ignoreErrors: []'] : []),
    '',
  ].join('\n'));
  if (stub) writeFixtureFile(fixture.root, 'phpstan-wordpress-compat.stub', '<?php\n');
}

test('cleared PHPStan baseline permits a higher level and one named compatibility stub', (t) => {
  const fixture = phpstanRetirementRepository();
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));
  retirePhpstanBaseline(fixture);
  const result = runChecker(fixture.root, fixture.revision);
  assert.equal(result.status, 0, result.stderr);
});

test('cleared PHPStan baseline still rejects analyzer configuration drift', (t) => {
  for (const variant of [
    { name: 'unchanged level', level: 5 },
    { name: 'lower level', level: 4 },
    { name: 'changed paths', path: 'tests' },
    { name: 'missing stub', stub: false },
    { name: 'new ignored errors', ignoreErrors: true },
  ]) {
    const fixture = phpstanRetirementRepository();
    t.after(() => rmSync(fixture.root, { force: true, recursive: true }));
    retirePhpstanBaseline(fixture, variant);
    const result = runChecker(fixture.root, fixture.revision);
    assert.equal(result.status, 2, variant.name + ': ' + result.stderr);
    assert.match(result.stderr, /may not add, remove, or change phpstan\.neon/u);
  }
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

test('existing PHPCS baseline permits only a monotonic WordPress minimum increase', (t) => {
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2"/>\n</ruleset>\n',
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="6.4"/>\n</ruleset>\n');
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 0, result.stderr);
});

test('PHPCS WordPress minimum migration accepts alternate valid attribute formatting', (t) => {
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': '<ruleset name="Fixture">\n  <config\n    value = \'5.2\'\n    name = \'minimum_supported_wp_version\'\n  />\n</ruleset>\n',
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', '<ruleset name="Fixture">\n  <config\n    value = \'6.4\'\n    name = \'minimum_supported_wp_version\'\n  />\n</ruleset>\n');
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 0, result.stderr);
});

test('PHPCS WordPress minimum migration accepts an explicit empty closing element', (t) => {
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2"></config>\n</ruleset>\n',
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="6.4"></config>\n</ruleset>\n');
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 0, result.stderr);
});

test('PHPCS WordPress minimum migration accepts greater-than signs inside quoted values', (t) => {
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': '<ruleset name="Fixture">\n  <config note="a>b" name="minimum_supported_wp_version" value="5.2"/>\n</ruleset>\n',
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', '<ruleset name="Fixture">\n  <config note="a>b" name="minimum_supported_wp_version" value="6.4"/>\n</ruleset>\n');
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 0, result.stderr);
});

test('PHPCS WordPress minimum migration applies to only one conventional configuration', (t) => {
  const baseConfig = '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2"/>\n</ruleset>\n';
  const headConfig = '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="6.4"/>\n</ruleset>\n';
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml': baseConfig,
    'phpcs.xml.dist': baseConfig,
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml', headConfig);
  writeFixtureFile(fixture.root, 'phpcs.xml.dist', headConfig);
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /only when exactly one conventional configuration is present/u);
});

test('PHPCS WordPress minimum migration rejects an inactive conventional configuration', (t) => {
  const baseConfig = '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2"/>\n</ruleset>\n';
  const headConfig = '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="6.4"/>\n</ruleset>\n';
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml': baseConfig,
    'phpcs.xml.dist': baseConfig,
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', headConfig);
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /only when exactly one conventional configuration is present/u);
});

test('PHPCS WordPress minimum migration ignores comments, CDATA, and processing instructions', (t) => {
  for (const [baseElement, headElement] of [
    [
      '<!-- <config name="minimum_supported_wp_version" value="5.2"/> -->',
      '<!-- <config name="minimum_supported_wp_version" value="6.4"/> -->',
    ],
    [
      '<![CDATA[<config name="minimum_supported_wp_version" value="5.2"/>]]>',
      '<![CDATA[<config name="minimum_supported_wp_version" value="6.4"/>]]>',
    ],
    [
      '<?policy <config name="minimum_supported_wp_version" value="5.2"/>?>',
      '<?policy <config name="minimum_supported_wp_version" value="6.4"/>?>',
    ],
  ]) {
    const fixture = createRepository({
      'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
      'phpcs-baseline.json': '{}\n',
      'phpcs.xml.dist': `<ruleset name="Fixture">\n  ${baseElement}\n</ruleset>\n`,
      'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
    });
    t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

    writeFixtureFile(fixture.root, 'phpcs.xml.dist', `<ruleset name="Fixture">\n  ${headElement}\n</ruleset>\n`);
    const result = runChecker(fixture.root, fixture.revision);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /may not add, remove, or change phpcs\.xml\.dist/u);
  }
});

test('PHPCS WordPress minimum migration ignores declarations and DOCTYPE subsets', (t) => {
  const base = '<!DOCTYPE ruleset [<!ENTITY floor "<config name=\'minimum_supported_wp_version\' value=\'5.2\'/>">]>\n<ruleset name="Fixture"/>\n';
  const head = '<!DOCTYPE ruleset [<!ENTITY floor "<config name=\'minimum_supported_wp_version\' value=\'6.4\'/>">]>\n<ruleset name="Fixture"/>\n';
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': base,
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', head);
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /may not add, remove, or change phpcs\.xml\.dist/u);
});

test('PHPCS WordPress minimum migration ignores nested config elements', (t) => {
  const base = '<ruleset name="Fixture">\n  <description><config name="minimum_supported_wp_version" value="5.2"/></description>\n</ruleset>\n';
  const head = '<ruleset name="Fixture">\n  <description><config name="minimum_supported_wp_version" value="6.4"/></description>\n</ruleset>\n';
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': base,
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', head);
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /may not add, remove, or change phpcs\.xml\.dist/u);
});

test('PHPCS WordPress minimum migration ignores attribute text inside quoted values', (t) => {
  const base = '<ruleset name="Fixture">\n  <config data=\'name="minimum_supported_wp_version" value="5.2"\'/>\n</ruleset>\n';
  const head = '<ruleset name="Fixture">\n  <config data=\'name="minimum_supported_wp_version" value="6.4"\'/>\n</ruleset>\n';
  const fixture = createRepository({
    'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
    'phpcs-baseline.json': '{}\n',
    'phpcs.xml.dist': base,
    'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
  });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs.xml.dist', head);
  const result = runChecker(fixture.root, fixture.revision);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /may not add, remove, or change phpcs\.xml\.dist/u);
});

test('PHPCS WordPress minimum migration rejects malformed duplicate settings', (t) => {
  for (const duplicate of [
    '<config name="minimum_supported_wp_version" value="invalid"/>',
    '<config name="minimum_supported_wp_version" value="invalid">ignored</config>',
  ]) {
    const base = `<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2"/>\n  ${duplicate}\n</ruleset>\n`;
    const head = `<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="6.4"/>\n  ${duplicate}\n</ruleset>\n`;
    const fixture = createRepository({
      'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
      'phpcs-baseline.json': '{}\n',
      'phpcs.xml.dist': base,
      'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
    });
    t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

    writeFixtureFile(fixture.root, 'phpcs.xml.dist', head);
    const result = runChecker(fixture.root, fixture.revision);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /may not add, remove, or change phpcs\.xml\.dist/u);
  }
});

test('PHPCS WordPress minimum migration rejects namespaced settings', (t) => {
  for (const [base, head] of [
    [
      '<ruleset name="Fixture">\n  <config xmlns="urn:ignored" name="minimum_supported_wp_version" value="5.2"/>\n</ruleset>\n',
      '<ruleset name="Fixture">\n  <config xmlns="urn:ignored" name="minimum_supported_wp_version" value="6.4"/>\n</ruleset>\n',
    ],
    [
      '<ruleset xmlns="urn:ignored" name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2"/>\n</ruleset>\n',
      '<ruleset xmlns="urn:ignored" name="Fixture">\n  <config name="minimum_supported_wp_version" value="6.4"/>\n</ruleset>\n',
    ],
  ]) {
    const fixture = createRepository({
      'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
      'phpcs-baseline.json': '{}\n',
      'phpcs.xml.dist': base,
      'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
    });
    t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

    writeFixtureFile(fixture.root, 'phpcs.xml.dist', head);
    const result = runChecker(fixture.root, fixture.revision);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /may not add, remove, or change phpcs\.xml\.dist/u);
  }
});

test('existing PHPCS baseline rejects a semantically unchanged or lower floor and accompanying configuration drift', (t) => {
  for (const source of [
    '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2.0"/>\n</ruleset>\n',
    '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.1"/>\n</ruleset>\n',
    '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2.00.0"/>\n</ruleset>\n',
    '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="100000000000000000000.1"/>\n</ruleset>\n',
    '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="6.4"/>\n  <rule ref="WordPress-Core"/>\n</ruleset>\n',
  ]) {
    const fixture = createRepository({
      'composer.json': `${JSON.stringify({ scripts: { phpcs: 'php scripts/check-phpcs-baseline.php' } }, null, 2)}\n`,
      'phpcs-baseline.json': '{}\n',
      'phpcs.xml.dist': source.includes('100000000000000000000.1')
        ? '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="100000000000000000001"/>\n</ruleset>\n'
        : source.includes('5.2.00.0')
          ? '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2.1"/>\n</ruleset>\n'
          : '<ruleset name="Fixture">\n  <config name="minimum_supported_wp_version" value="5.2"/>\n</ruleset>\n',
      'scripts/check-phpcs-baseline.php': "<?php\necho 'checked';\n",
    });
    t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

    writeFixtureFile(fixture.root, 'phpcs.xml.dist', source);
    const result = runChecker(fixture.root, fixture.revision);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /may not add, remove, or change phpcs\.xml\.dist/u);
  }
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

test('central PHPCS accepts an initial baseline without repository-owned analyzer tooling', (t) => {
  const fixture = createRepository({ 'README.md': 'Fixture\n' });
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));

  writeFixtureFile(fixture.root, 'phpcs-baseline.json', '{}\n');

  const result = runChecker(fixture.root, fixture.revision, '--central-phpcs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initial baseline introduction permitted/u);
});
