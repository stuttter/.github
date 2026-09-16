import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  resolveProjectCheckPolicy,
  validateInstalledPhpunit,
  validateNodeProject,
  validatePhpunitProject,
  validateProjectChecks,
  validateSmokeProject,
} from '../scripts/project-check-policy.mjs';

const policyScript = new URL('../scripts/project-check-policy.mjs', import.meta.url);
const compatibilityPolicyScript = new URL('../scripts/compatibility-policy.mjs', import.meta.url);
const digest = (source) => createHash('sha256').update(source).digest('hex');
const configSource = '<phpunit bootstrap="tests/bootstrap.php"><testsuites><testsuite name="Fixture"><directory>tests</directory></testsuite></testsuites></phpunit>\n';
const bootstrapSource = '<?php\n';
const composerSource = `${JSON.stringify({ scripts: { test: 'phpunit' } })}\n`;
const lockSource = `${JSON.stringify({ packages: [], 'packages-dev': [{ name: 'phpunit/phpunit', version: '9.6.0' }] })}\n`;

function fileContract(path, source) {
  return { path, sha256: digest(source) };
}

function phpunitContract() {
  return {
    config: 'phpunit.xml.dist',
    files: [
      fileContract('composer.json', composerSource),
      fileContract('composer.lock', lockSource),
      fileContract('phpunit.xml.dist', configSource),
      fileContract('tests/bootstrap.php', bootstrapSource),
    ],
  };
}

function target(repository, checks, multisite = false) {
  return { repository, enabled: true, checks, manifest: { minimum_php: '7.4', multisite } };
}

function put(root, path, source) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
}

function phpunitProject() {
  const root = mkdtempSync(join(tmpdir(), 'phpunit-contract-'));
  put(root, 'composer.json', composerSource);
  put(root, 'composer.lock', lockSource);
  put(root, 'phpunit.xml.dist', configSource);
  put(root, 'tests/bootstrap.php', bootstrapSource);
  return root;
}

test('PHP-only profile schedules the centrally hashed minimum-PHP contract', () => {
  const policy = resolveProjectCheckPolicy({ repositories: [target('example/php-only', { phpunit: phpunitContract() })] }, 'example/php-only');
  assert.equal(policy.matrix.include[0].kind, 'minimum-php');
  assert.equal(policy.matrix.include[0].php, '7.4');
  assert.equal(policy.matrix.include[0].config, 'phpunit.xml.dist');
  assert.deepEqual(policy.phpunit, phpunitContract());
});

test('project checks reject an enabled repository below the PHP fleet baseline', () => {
  const legacy = target('example/legacy', { phpunit: phpunitContract() });
  legacy.manifest.minimum_php = '7.3';
  assert.throws(
    () => resolveProjectCheckPolicy({ repositories: [legacy] }, legacy.repository),
    /minimum_php must be 7\.4 or newer/u,
  );
});

test('profile without an established suite produces an explicit no-op cell', () => {
  const policy = resolveProjectCheckPolicy({ repositories: [target('example/no-suite', { phpunit: false })] }, 'example/no-suite');
  assert.equal(policy.matrix.include[0].kind, 'none');
  assert.equal(policy.phpunit, null);
});

test('Node profile requires maintained versions and every fixed transitive alias', () => {
  const scripts = {
    build: 'npm run dev && npm run prod',
    'build:check': 'npm run build && npm run generated:check && npm run vendor:check && git diff --exit-code -- wp-chosen/assets/css/wp-chosen.css wp-chosen/assets/css/wp-chosen.css.map wp-chosen/assets/css/wp-chosen.min.css',
    dev: 'postcss wp-chosen/assets/css/scss/wp-chosen.scss --output wp-chosen/assets/css/wp-chosen.css --env dev --config wp-chosen/assets/css/postcss-configs/main',
    'generated:check': 'node bin/check-generated-assets.mjs',
    prod: 'postcss wp-chosen/assets/css/scss/wp-chosen.scss --output wp-chosen/assets/css/wp-chosen.min.css --env prod  --config wp-chosen/assets/css/postcss-configs/main',
    'vendor:check': 'node bin/check-vendored-assets.mjs',
  };
  const packageSource = `${JSON.stringify({ scripts })}\n`;
  const lockSource = '{}\n';
  const generatedHelper = 'console.log("generated");\n';
  const vendorHelper = 'console.log("vendor");\n';
  const helperConfig = '{}\n';
  const sourceCss = '$color: red;\n';
  const outputCss = 'body{}\n';
  const outputMap = '{}\n';
  const minifiedCss = 'body{}';
  const node = {
    version: '24',
    script: 'build:check',
    scripts,
    files: [
      fileContract('package.json', packageSource),
      fileContract('package-lock.json', lockSource),
      fileContract('bin/check-generated-assets.mjs', generatedHelper),
      fileContract('bin/check-vendored-assets.mjs', vendorHelper),
      fileContract('wp-chosen/assets/css/postcss-configs/main/postcss.config.js', helperConfig),
      fileContract('wp-chosen/assets/css/scss/wp-chosen.scss', sourceCss),
      fileContract('wp-chosen/assets/css/wp-chosen.css', outputCss),
      fileContract('wp-chosen/assets/css/wp-chosen.css.map', outputMap),
      fileContract('wp-chosen/assets/css/wp-chosen.min.css', minifiedCss),
    ],
  };
  const policy = resolveProjectCheckPolicy({ repositories: [target('example/node', { phpunit: false, node })] }, 'example/node');
  assert.equal(policy.matrix.include[0].kind, 'node-assets');
  assert.deepEqual(policy.node, node);
  assert.match(validateProjectChecks({ phpunit: false, node: { ...node, version: '20' } }).join('\n'), /version is unsupported/u);
  assert.match(validateProjectChecks({ phpunit: false, node: { ...node, scripts: { 'build:check': 'npm run build' } } }).join('\n'), /undeclared npm alias build/u);
  assert.match(validateProjectChecks({ phpunit: false, node: { version: '24', script: 'build:check', scripts: node.scripts } }).join('\n'), /node\.files must be a non-empty array/u);
  assert.match(validateProjectChecks({ phpunit: false, node: { ...node, files: node.files.slice(1) } }).join('\n'), /must hash package\.json/u);
  assert.match(validateProjectChecks({ phpunit: false, node: { ...node, files: node.files.filter(({ path }) => path !== 'bin/check-generated-assets.mjs') } }).join('\n'), /must hash command path bin\/check-generated-assets\.mjs/u);
  assert.match(validateProjectChecks({ phpunit: false, node: { ...node, files: node.files.filter(({ path }) => path !== 'wp-chosen/assets/css/postcss-configs/main/postcss.config.js') } }).join('\n'), /must hash command path wp-chosen\/assets\/css\/postcss-configs\/main\/postcss\.config\.js/u);
  assert.match(validateProjectChecks({ phpunit: false, node: { ...node, files: node.files.filter(({ path }) => path !== 'wp-chosen/assets/css/scss/wp-chosen.scss') } }).join('\n'), /must hash command path wp-chosen\/assets\/css\/scss\/wp-chosen\.scss/u);
  assert.match(validateProjectChecks({ phpunit: false, node: { ...node, files: node.files.filter(({ path }) => path !== 'wp-chosen/assets/css/wp-chosen.min.css') } }).join('\n'), /must hash command path wp-chosen\/assets\/css\/wp-chosen\.min\.css/u);
});

test('Node command grammar rejects shell bypasses and unapproved commands', () => {
  const base = {
    version: '24',
    script: 'build:check',
    files: [fileContract('package.json', '{}\n'), fileContract('package-lock.json', '{}\n'), fileContract('bin/build.mjs', 'build\n')],
  };
  const rejected = [
    '(node bin/build.mjs)',
    'node <bin/build.mjs',
    'node $(printf bin/build.mjs)',
    'node $PWD/bin/build.mjs',
    'bash bin/build.mjs',
    'node bin/build.mjs | cat',
    'node bin/build.mjs; true',
    'node "bin/build.mjs"',
    'node bin/*.mjs',
    'node bin/build.mjs > assets/output.css',
  ];
  for (const command of rejected) {
    const node = { ...base, scripts: { 'build:check': command } };
    assert.match(validateProjectChecks({ phpunit: false, node }).join('\n'), /unsupported shell syntax|unapproved executable or command form/u, command);
  }
});

test('live-smoke profile requires hashes for both entry points and helpers', () => {
  const files = [
    fileContract('tests/run-single.sh', 'single\n'),
    fileContract('tests/run-multi.sh', 'multi\n'),
    fileContract('tests/helper.sh', 'helper\n'),
    fileContract('tests/single.php', '<?php // single\n'),
    fileContract('tests/multi.php', '<?php // multi\n'),
  ];
  const smoke = {
    single_site: 'tests/run-single.sh',
    multisite: 'tests/run-multi.sh',
    payloads: { single_site: 'tests/single.php', multisite: 'tests/multi.php' },
    files,
  };
  const policy = resolveProjectCheckPolicy({ repositories: [target('example/live', { phpunit: false, smoke }, true)] }, 'example/live');
  assert.deepEqual(policy.matrix.include.map(({ kind, script }) => ({ kind, script })), [
    { kind: 'live-smoke', script: 'tests/run-single.sh' },
    { kind: 'live-smoke', script: 'tests/run-multi.sh' },
  ]);
  const missingEntry = { ...smoke, files: files.slice(1) };
  assert.match(validateProjectChecks({ phpunit: false, smoke: missingEntry }, 'checks', true).join('\n'), /must hash tests\/run-single\.sh/u);
  const missingPayload = { ...smoke, files: files.filter(({ path }) => path !== 'tests/multi.php') };
  assert.match(validateProjectChecks({ phpunit: false, smoke: missingPayload }, 'checks', true).join('\n'), /must hash tests\/multi\.php/u);
  const omittedPayload = { ...smoke, payloads: { single_site: 'tests/single.php' } };
  assert.match(validateProjectChecks({ phpunit: false, smoke: omittedPayload }, 'checks', true).join('\n'), /payloads\.multisite/u);
});

test('project policy rejects unsafe paths, CR/LF, bad hashes, and unsupported keys', () => {
  assert.match(validateProjectChecks({}).join('\n'), /explicitly declare phpunit/u);
  assert.match(validateProjectChecks({ phpunit: true }).join('\n'), /false or an object/u);
  assert.match(validateProjectChecks({ phpunit: false, smoke: { single_site: 'tests/run.sh\n', files: [] } }).join('\n'), /without line breaks/u);
  const contract = phpunitContract();
  contract.files[0].sha256 = 'abc';
  assert.match(validateProjectChecks({ phpunit: contract }).join('\n'), /lowercase SHA-256/u);
});

test('centrally enrolled PHPUnit rejects a no-op Composer alias plus package, hash, and binary drift', (t) => {
  const root = phpunitProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = phpunitContract();
  assert.doesNotThrow(() => validatePhpunitProject(root, contract));

  put(root, 'composer.json', '{"scripts":{"test":"true"}}\n');
  assert.throws(() => validatePhpunitProject(root, contract), /composer\.json does not match/u);
  put(root, 'composer.json', composerSource);
  put(root, 'composer.lock', '{"packages":[],"packages-dev":[]}\n');
  assert.throws(() => validatePhpunitProject(root, contract), /locked phpunit\/phpunit/u);
  put(root, 'composer.lock', lockSource);
  put(root, 'tests/bootstrap.php', '<?php // bypass\n');
  assert.throws(() => validatePhpunitProject(root, contract), /does not match its centrally approved SHA-256/u);
  put(root, 'tests/bootstrap.php', bootstrapSource);

  assert.throws(() => validateInstalledPhpunit(root), /is missing vendor\/bin\/phpunit/u);
  put(root, 'vendor/bin/phpunit', '#!/bin/sh\nexit 0\n');
  assert.throws(() => validateInstalledPhpunit(root), /executable locked/u);
  chmodSync(join(root, 'vendor/bin/phpunit'), 0o755);
  assert.doesNotThrow(() => validateInstalledPhpunit(root));
});

test('Node command and transitive alias drift fail closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'node-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = {
    'build:check': 'npm run build && git diff --exit-code -- assets/output.css',
    build: 'postcss assets/source.css --output assets/output.css --env prod --config config/main && node bin/build.mjs',
  };
  const packageSource = `${JSON.stringify({ scripts })}\n`;
  const lockSource = '{}\n';
  const helperSource = 'console.log("build");\n';
  const helperConfig = 'export default {};\n';
  const sourceCss = 'body {}\n';
  const outputCss = 'body{}\n';
  put(root, 'package-lock.json', lockSource);
  const contract = {
    version: '24',
    script: 'build:check',
    scripts,
    files: [fileContract('package.json', packageSource), fileContract('package-lock.json', lockSource), fileContract('bin/build.mjs', helperSource), fileContract('config/main/postcss.config.js', helperConfig), fileContract('assets/source.css', sourceCss), fileContract('assets/output.css', outputCss)],
  };
  put(root, 'package.json', packageSource);
  put(root, 'bin/build.mjs', helperSource);
  put(root, 'config/main/postcss.config.js', helperConfig);
  put(root, 'assets/source.css', sourceCss);
  put(root, 'assets/output.css', outputCss);
  assert.doesNotThrow(() => validateNodeProject(root, contract));
  put(root, 'package.json', `${JSON.stringify({ scripts: { ...contract.scripts, 'build:check': 'true' } })}\n`);
  assert.throws(() => validateNodeProject(root, contract), /scripts\.build:check/u);
  put(root, 'package.json', `${JSON.stringify({ scripts: { ...contract.scripts, build: 'true' } })}\n`);
  assert.throws(() => validateNodeProject(root, contract), /scripts\.build/u);
  put(root, 'package.json', `${JSON.stringify({ scripts: { ...contract.scripts, release: 'true' } })}\n`);
  assert.throws(() => validateNodeProject(root, contract), /exact approved package script names/u);
  put(root, 'package.json', packageSource);
  put(root, 'package-lock.json', '{"packages":{"node_modules/example":{"hasInstallScript":true}}}\n');
  assert.throws(() => validateNodeProject(root, contract), /package-lock\.json does not match/u);
  put(root, 'package-lock.json', lockSource);
  put(root, 'bin/build.mjs', 'console.log("bypass");\n');
  assert.throws(() => validateNodeProject(root, contract), /bin\/build\.mjs does not match/u);
  put(root, 'bin/build.mjs', helperSource);
  put(root, 'config/main/postcss.config.js', 'export default { bypass: true };\n');
  assert.throws(() => validateNodeProject(root, contract), /config\/main\/postcss\.config\.js does not match/u);
  put(root, 'config/main/postcss.config.js', helperConfig);
  put(root, 'assets/output.css', 'changed\n');
  assert.throws(() => validateNodeProject(root, contract), /assets\/output\.css does not match/u);
});

test('unchanged smoke wrappers cannot hide a changed helper', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = { 'tests/run.sh': 'bash tests/helper.sh\n', 'tests/helper.sh': 'run checks\n' };
  for (const [path, source] of Object.entries(sources)) put(root, path, source);
  sources['tests/smoke.php'] = '<?php // smoke\n';
  put(root, 'tests/smoke.php', sources['tests/smoke.php']);
  const contract = { single_site: 'tests/run.sh', payloads: { single_site: 'tests/smoke.php' }, files: Object.entries(sources).map(([path, source]) => fileContract(path, source)) };
  assert.doesNotThrow(() => validateSmokeProject(root, contract));
  put(root, 'tests/helper.sh', 'exit 0\n');
  assert.throws(() => validateSmokeProject(root, contract), /helper\.sh does not match/u);
  put(root, 'tests/helper.sh', sources['tests/helper.sh']);
  put(root, 'tests/smoke.php', '<?php // bypass\n');
  assert.throws(() => validateSmokeProject(root, contract), /smoke\.php does not match/u);
});

test('CLI loads its adjacent immutable inventory and emits exact GitHub outputs', (t) => {
  const root = phpunitProject();
  const standard = mkdtempSync(join(tmpdir(), 'project-policy-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(standard, { recursive: true, force: true }));
  put(standard, 'portfolio/plugins.json', `${JSON.stringify({ repositories: [target('example/cli', { phpunit: phpunitContract() })] })}\n`);
  mkdirSync(join(standard, 'scripts'), { recursive: true });
  copyFileSync(policyScript, join(standard, 'scripts/project-check-policy.mjs'));
  copyFileSync(compatibilityPolicyScript, join(standard, 'scripts/compatibility-policy.mjs'));
  put(root, 'portfolio/plugins.json', '{"repositories":[]}\n');

  const success = spawnSync(process.execPath, [join(standard, 'scripts/project-check-policy.mjs'), '--repository', 'example/cli', '--project-root', root], { cwd: root, encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  const expectedMatrix = resolveProjectCheckPolicy({ repositories: [target('example/cli', { phpunit: phpunitContract() })] }, 'example/cli').matrix;
  assert.equal(success.stdout, `matrix=${JSON.stringify(expectedMatrix)}\nnode_enabled=false\nnode_version=\nnode_script=\nphpunit_enabled=true\nphpunit_config=phpunit.xml.dist\n`);

  const missingRoot = spawnSync(process.execPath, [join(standard, 'scripts/project-check-policy.mjs'), '--repository', 'example/cli'], { cwd: root, encoding: 'utf8' });
  assert.equal(missingRoot.status, 2);
  assert.match(missingRoot.stderr, /--project-root/u);
});
