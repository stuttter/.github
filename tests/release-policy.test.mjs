import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/wordpress-plugin-release.yml', import.meta.url), 'utf8');
const builderUrl = new URL('../scripts/build-plugin.sh', import.meta.url);
const builderPath = fileURLToPath(builderUrl);
const builder = readFileSync(builderUrl, 'utf8');

function archiveFixture({ symlink = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-archive-'));
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, '.github/plugin-standard.json'), '{"slug":"fixture-plugin","main_file":"fixture-plugin.php"}\n');
  writeFileSync(join(root, '.gitattributes'), '.github export-ignore\n');
  writeFileSync(join(root, 'fixture-plugin.php'), '<?php\n/*\n * Version: 1.0.0\n */\n');
  writeFileSync(join(root, 'target.txt'), 'target\n');
  if (symlink) symlinkSync('target.txt', join(root, 'linked.txt'));

  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Archive Fixture']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.test']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runBuilder(root, output, timezone, mask) {
  return spawnSync(
    'bash',
    ['-c', 'umask "${1}"; exec bash "${2}" "${3}" "${4}"', 'archive-fixture', mask, builderPath, root, output],
    { encoding: 'utf8', env: { ...process.env, TZ: timezone } },
  );
}

test('production archives bind HEAD once and use that immutable commit', () => {
  const commands = builder.replace(/\\\n[ \t]*/gu, ' ').split('\n').map((command) => command.trim());
  const headResolutions = commands.filter((command) => (
    /^commit_sha="\$\(git(?:\s|$)/u.test(command)
    && /\brev-parse\b/u.test(command)
    && /--verify(?:\s|=)/u.test(command)
    && /['"]HEAD\^\{commit\}['"]/u.test(command)
  ));
  const tarArchives = commands.filter((command) => (
    /^git(?:\s|$)/u.test(command)
    && /\barchive\b/u.test(command)
    && /--format(?:=|\s+)tar\b/u.test(command)
  ));
  const zipArchives = commands.filter((command) => (
    /^(?:TZ=UTC\s+|env\s+TZ=UTC\s+)git(?:\s|$)/u.test(command)
    && /\barchive\b/u.test(command)
    && /--format(?:=|\s+)zip\b/u.test(command)
  ));

  assert.equal(headResolutions.length, 1);
  assert.equal(tarArchives.length, 1);
  assert.equal(zipArchives.length, 1);
  const [tarArchive] = tarArchives;
  const [zipArchive] = zipArchives;
  assert.match(tarArchive.split(/\s+\|\s+/u, 1)[0], /\s"\$\{commit_sha\}"\s*$/u);
  assert.match(zipArchive, /--prefix(?:=|\s+)"\$\{slug\}\/"/u);
  assert.match(zipArchive, /--output(?:=|\s+)"\$\{archive_path\}"/u);
  assert.match(zipArchive, /\s"\$\{commit_sha\}"\s*$/u);
  assert.doesNotMatch(`${tarArchive}\n${zipArchive}`, /\bHEAD\b/u);
  assert.doesNotMatch(builder, /(?:^|\n)\s*(?:env\s+\S+\s+)*zip\s+-|&&\s*zip\s+-/u);
});

test('production archive builder rejects tracked symbolic links before writing a ZIP', () => {
  const { root, cleanup } = archiveFixture({ symlink: true });
  const output = join(root, 'output');
  try {
    const result = runBuilder(root, output, 'UTC', '022');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release artifact contains a symbolic link/u);
    assert.equal(existsSync(join(output, 'fixture-plugin-1.0.0.zip')), false);
    assert.equal(existsSync(join(output, 'fixture-plugin-1.0.0.zip.sha256')), false);
  } finally {
    cleanup();
  }
});

test('production archive builder emits deterministic bytes and expected entries', () => {
  const { root, cleanup } = archiveFixture();
  const firstOutput = join(root, 'output-first');
  const secondOutput = join(root, 'output-second');
  try {
    assert.equal(existsSync(firstOutput), false);
    assert.equal(existsSync(secondOutput), false);
    const first = runBuilder(root, firstOutput, 'America/Chicago', '022');
    const second = runBuilder(root, secondOutput, 'Pacific/Auckland', '077');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(existsSync(firstOutput), true);
    assert.equal(existsSync(secondOutput), true);

    const firstArchive = join(firstOutput, 'fixture-plugin-1.0.0.zip');
    const secondArchive = join(secondOutput, 'fixture-plugin-1.0.0.zip');
    const firstBytes = readFileSync(firstArchive);
    assert.deepEqual(firstBytes, readFileSync(secondArchive));

    const digest = createHash('sha256').update(firstBytes).digest('hex');
    assert.equal(readFileSync(`${firstArchive}.sha256`, 'utf8').split(/\s/u, 1)[0], digest);
    assert.equal(readFileSync(`${secondArchive}.sha256`, 'utf8').split(/\s/u, 1)[0], digest);

    const entries = execFileSync('unzip', ['-Z1', firstArchive], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(entries, [
      'fixture-plugin/',
      'fixture-plugin/.gitattributes',
      'fixture-plugin/fixture-plugin.php',
      'fixture-plugin/target.txt',
    ]);
  } finally {
    cleanup();
  }
});

test('release authorization hard-codes its protected environment and binds its branch', () => {
  assert.match(workflow, /^    environment: wordpress\.org$/m);
  assert.doesNotMatch(workflow, /\$\{\{ inputs\.environment \}\}/);
  assert.doesNotMatch(workflow, /RELEASE_ENVIRONMENT/);
  assert.equal((workflow.match(/test "\$\{RELEASE_BRANCH\}" = "\$\{expected_branch\}"/g) || []).length, 3);
});

test('legacy release callers may pass an ignored environment input during migration', () => {
  const interfaceBlock = workflow.slice(0, workflow.indexOf('\nconcurrency:'));
  assert.match(interfaceBlock, /^      environment:$/m);
  assert.match(interfaceBlock, /Deprecated compatibility input\. Publishing always uses the wordpress\.org environment\./);
});

test('release inputs enforce canonical SemVer and WordPress.org eligibility', () => {
  assert.match(workflow, /\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/);
  assert.equal((workflow.match(/test "\$\{actual_wordpress_org\}" = 'true'/g) || []).length, 3);
  assert.equal((workflow.match(/test "\$\{actual_minimum_php\}" = "\$\{expected_minimum_php\}"/g) || []).length, 3);
  assert.equal((workflow.match(/test "\$\{actual_minimum_wordpress\}" = "\$\{expected_minimum_wordpress\}"/g) || []).length, 3);
});

test('WordPress.org credentials use an explicit required reusable-workflow interface', () => {
  const interfaceBlock = workflow.slice(0, workflow.indexOf('\nconcurrency:'));
  assert.match(interfaceBlock, /STUTTTER_WORDPRESS_ORG_USERNAME:[\s\S]*?required: true/);
  assert.match(interfaceBlock, /STUTTTER_WORDPRESS_ORG_PASSWORD:[\s\S]*?required: true/);
  assert.doesNotMatch(interfaceBlock, /^      WORDPRESS_ORG_(?:USERNAME|PASSWORD):$/m);
  assert.match(workflow, /WORDPRESS_ORG_USERNAME: \$\{\{ secrets\.STUTTTER_WORDPRESS_ORG_USERNAME \}\}/);
  assert.match(workflow, /WORDPRESS_ORG_PASSWORD: \$\{\{ secrets\.STUTTTER_WORDPRESS_ORG_PASSWORD \}\}/);
  assert.doesNotMatch(workflow, /WORDPRESS_ORG_USERNAME: \$\{\{ secrets\.WORDPRESS_ORG_USERNAME \}\}/);
  assert.doesNotMatch(workflow, /WORDPRESS_ORG_PASSWORD: \$\{\{ secrets\.WORDPRESS_ORG_PASSWORD \}\}/);
});

test('the protected publisher installs Subversion before release target verification', () => {
  const installStep = workflow.indexOf('      - name: Install Subversion client');
  const verifyStep = workflow.indexOf('      - name: Re-verify artifact and release targets');
  const publishStep = workflow.indexOf('      - name: Publish one atomic WordPress.org changeset');

  assert.notEqual(installStep, -1);
  assert.match(workflow.slice(installStep, verifyStep), /apt-get install --yes --no-install-recommends subversion/);
  assert.ok(installStep < verifyStep);
  assert.ok(verifyStep < publishStep);
});

test('the protected publisher stages trunk and its tag independently from the approved artifact', () => {
  const publishStep = workflow.indexOf('      - name: Publish one atomic WordPress.org changeset');
  const verifyStep = workflow.indexOf('      - name: Verify public WordPress.org ZIP');
  const publishBlock = workflow.slice(publishStep, verifyStep);

  assert.match(publishBlock, /svn update --set-depth infinity "\$\{svn_root\}\/trunk"/);
  assert.match(
    publishBlock,
    /rsync --archive --delete "\$\{stage_root\}\/\$\{PLUGIN_SLUG\}\/" "\$\{svn_root\}\/trunk\/"/,
  );
  assert.match(publishBlock, /tag_root="\$\{svn_root\}\/tags\/\$\{VERSION\}"/);
  assert.match(
    publishBlock,
    /rsync --archive "\$\{stage_root\}\/\$\{PLUGIN_SLUG\}\/" "\$\{tag_root\}\/"/,
  );
  assert.match(publishBlock, /svn add --force "\$\{tag_root\}"/);
  assert.doesNotMatch(publishBlock, /svn copy/);
  assert.match(publishBlock, /svn commit[\s\S]*?"\$\{svn_root\}\/trunk"[\s\S]*?"\$\{tag_root\}"/);
});
