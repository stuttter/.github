import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/run-fleet-phpcs.php', import.meta.url));
const runnerSource = readFileSync(runner, 'utf8');
const phpcsLock = JSON.parse(readFileSync(new URL('../tools/phpcs/composer.lock', import.meta.url), 'utf8'));

function php(program) {
  return spawnSync('php', ['-r', `require ${JSON.stringify(runner)}; ${program}`], { encoding: 'utf8' });
}

test('fleet PHPCS comparisons allow only equal or reduced debt', () => {
  const result = php(`
    $baseline = array('plugin.php|WordPress.Security.ValidatedSanitizedInput.InputNotSanitized' => 2);
    $reduced = array('plugin.php|WordPress.Security.ValidatedSanitizedInput.InputNotSanitized' => 1);
    $increased = array('plugin.php|WordPress.Security.ValidatedSanitizedInput.InputNotSanitized' => 3);
    echo json_encode(array(fleet_phpcs_compare($baseline, $reduced), fleet_phpcs_compare($baseline, $increased)));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [[], ['plugin.php|WordPress.Security.ValidatedSanitizedInput.InputNotSanitized increased from 2 to 3.']]);
});

test('fleet PHPCS accepts future PHP floors without weakening 7.4', () => {
  const result = php(`echo json_encode(array(
    fleet_phpcs_valid_minimum_php('7.3'),
    fleet_phpcs_valid_minimum_php('7.4'),
    fleet_phpcs_valid_minimum_php('9.0'),
    fleet_phpcs_valid_minimum_php('9.0-dev')
  ));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, true, true, false]);
});

test('fleet PHPCS encodes an empty canonical baseline as an object', () => {
  const result = php(`echo fleet_phpcs_encode_baseline(array());`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{}\n');
});

test('fleet PHPCS accepts whitespace in an empty object and rejects an empty array', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-phpcs-empty-baseline-'));
  const baseline = join(root, 'phpcs-baseline.json');
  t.after(() => rmSync(root, { force: true, recursive: true }));

  writeFileSync(baseline, '{\n}\n');
  let result = php(`echo json_encode(fleet_phpcs_baseline(${JSON.stringify(baseline)}));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);

  writeFileSync(baseline, '[]\n');
  result = php(`fleet_phpcs_baseline(${JSON.stringify(baseline)});`);
  assert.equal(result.status, 255);
  assert.match(result.stderr, /must contain an object/u);
});

test('fleet PHPCS applies one path rule to generated and loaded baseline keys', () => {
  const result = php(`echo json_encode(array(
    fleet_phpcs_safe_relative_path('includes/Some Class.php'),
    fleet_phpcs_safe_relative_path('../secret.php'),
    fleet_phpcs_safe_relative_path('includes/bad|name.php')
  ));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, false, false]);
});

test('fleet PHPCS replaces baselines atomically with canonical permissions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-phpcs-write-'));
  const baseline = join(root, 'phpcs-baseline.json');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(baseline, '{"old.php|Example.Sniff":1}\n');

  const result = php(`fleet_phpcs_write_baseline(${JSON.stringify(baseline)}, "{}\\n");`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(baseline, 'utf8'), '{}\n');
});

test('fleet PHPCS baseline rejects traversal keys and symbolic links', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-phpcs-baseline-'));
  const outside = join(root, 'outside.json');
  t.after(() => rmSync(root, { force: true, recursive: true }));

  writeFileSync(outside, '{"../secret.php|WordPress.Security.Bad":1}\n');
  let result = php(`fleet_phpcs_baseline(${JSON.stringify(outside)});`);
  assert.equal(result.status, 255);
  assert.match(result.stderr, /unsafe key/u);

  const link = join(root, 'baseline.json');
  symlinkSync(outside, link);
  result = php(`fleet_phpcs_baseline(${JSON.stringify(link)});`);
  assert.equal(result.status, 255);
  assert.match(result.stderr, /regular file/u);

  const dangling = join(root, 'dangling.json');
  symlinkSync(join(root, 'missing.json'), dangling);
  result = php(`fleet_phpcs_baseline_missing(${JSON.stringify(dangling)});`);
  assert.equal(result.status, 255);
  assert.match(result.stderr, /regular file/u);

  result = php(`fleet_phpcs_baseline(${JSON.stringify(dangling)});`);
  assert.equal(result.status, 255);
  assert.match(result.stderr, /regular file/u);
});

test('fleet PHPCS passes the WordPress floor through the locked WPCS runtime key', () => {
  const lockedPackages = [...(phpcsLock.packages || []), ...(phpcsLock['packages-dev'] || [])];
  const wpcs = lockedPackages.find(({ name }) => name === 'wp-coding-standards/wpcs');
  assert.equal(wpcs?.version, '3.4.1');
  assert.equal(phpcsLock.packages.length, 0);
  assert.match(runnerSource, /'--runtime-set', 'minimum_wp_version', \$policy\['minimum_wordpress'\]/u);
  assert.doesNotMatch(runnerSource, /'--runtime-set', 'minimum_supported_wp_version'/u);
});

test('fleet PHPCS derives compatibility values only from one enabled inventory entry', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-phpcs-policy-'));
  mkdirSync(join(root, 'portfolio'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, 'portfolio', 'plugins.json'), `${JSON.stringify({ repositories: [{
    repository: 'stuttter/example',
    enabled: true,
    manifest: { slug: 'example', minimum_php: '7.4', minimum_wordpress: '6.4' },
  }] })}\n`);

  const result = php(`echo json_encode(fleet_phpcs_policy(${JSON.stringify(root)}, 'stuttter/example'));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    slug: 'example',
    minimum_php: '7.4',
    minimum_wordpress: '6.4',
  });
});

test('fleet PHPCS rejects repository-controlled compatibility values', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-phpcs-policy-'));
  mkdirSync(join(root, 'portfolio'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, 'portfolio', 'plugins.json'), `${JSON.stringify({ repositories: [{
    repository: 'stuttter/example',
    enabled: true,
    manifest: { slug: 'example\n--runtime-set', minimum_php: '7.4', minimum_wordpress: '6.4' },
  }] })}\n`);

  const result = php(`fleet_phpcs_policy(${JSON.stringify(root)}, 'stuttter/example');`);
  assert.equal(result.status, 255);
  assert.match(result.stderr, /text domain is unsafe/u);
});
