import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadInventory, synchronize, validateManifest } from '../scripts/sync-plugin-standards.mjs';

const target = {
  repository: 'stuttter/example-plugin',
  enabled: true,
  managed_paths: ['ci', 'release', 'dependabot'],
  checks: { phpunit: false },
  integration: {},
  manifest: {
    slug: 'example-plugin',
    main_file: 'example-plugin.php',
    risk: 'standard',
    minimum_php: '7.4',
    minimum_wordpress: '6.4',
    tested_wordpress: '7.1',
    wordpress_org: true,
    multisite: false,
    release_branch: 'master',
    php_matrix: ['7.4', '8.4'],
  },
};
const policyRef = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-sync-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('audit reports missing managed files without writing', () => {
  const { root, cleanup } = fixture();
  try {
    const result = synchronize({ root, target, policyRef, mode: 'audit' });
    assert.deepEqual(result.changes.map(({ path }) => path), [
      '.github/plugin-standard.json',
      '.github/skills/code-review/SKILL.md',
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/dependabot.yml',
    ]);
    assert.equal(result.conflicts.length, 0);
    assert.equal(existsSync(join(root, '.github')), false);
    assert.equal(result.clean, false);
  } finally {
    cleanup();
  }
});

test('apply creates deterministic files and becomes clean', () => {
  const { root, cleanup } = fixture();
  try {
    const first = synchronize({ root, target, policyRef, mode: 'apply' });
    assert.equal(first.changes.length, 5);
    const second = synchronize({ root, target, policyRef, mode: 'audit' });
    assert.equal(second.clean, true);
    assert.match(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), /php-versions: '\["7\.4","8\.4"\]'/);
    assert.equal(
      readFileSync(join(root, '.github/skills/code-review/SKILL.md'), 'utf8'),
      readFileSync(new URL('../.github/skills/code-review/SKILL.md', import.meta.url), 'utf8'),
    );
  } finally {
    cleanup();
  }
});

test('Dependabot follows every package manifest present in a repository', () => {
  for (const [manifests, expected, unexpected = []] of [
    [[], ['github-actions'], ['composer', 'npm']],
    [['composer.json'], ['github-actions', 'composer'], ['npm']],
    [['package.json'], ['github-actions', 'npm'], ['composer']],
    [['composer.json', 'package.json'], ['github-actions', 'composer', 'npm']],
  ]) {
    const { root, cleanup } = fixture();
    try {
      for (const manifest of manifests) writeFileSync(join(root, manifest), '{}\n');
      synchronize({ root, target, policyRef, mode: 'apply' });
      const dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8');
      for (const ecosystem of expected) assert.match(dependabot, new RegExp(`package-ecosystem: ${ecosystem}`));
      for (const ecosystem of unexpected) assert.doesNotMatch(dependabot, new RegExp(`package-ecosystem: ${ecosystem}`));
    } finally {
      cleanup();
    }
  }
});

test('rendered workflow branch values remain strings for YAML boolean words', () => {
  const { root, cleanup } = fixture();
  try {
    const booleanBranch = structuredClone(target);
    booleanBranch.manifest.release_branch = 'true';
    synchronize({ root, target: booleanBranch, policyRef, mode: 'apply' });
    assert.match(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), /- "true"/);
    assert.match(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'), /release-branch: "true"/);
  } finally {
    cleanup();
  }
});

test('managed files update while repository-owned files are preserved', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), '# local workflow\n');
    writeFileSync(join(root, '.github/workflows/release.yml'), '# Managed by stuttter/.github fleet standards. Do not edit locally.\nstale\n');
    const result = synchronize({ root, target, policyRef, mode: 'apply' });
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].path, '.github/workflows/ci.yml');
    assert.equal(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), '# local workflow\n');
    assert.match(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'), /stale/);
    assert.equal(existsSync(join(root, '.github/plugin-standard.json')), false);
  } finally {
    cleanup();
  }
});

test('managed review skill preserves repository-specific skills and neighboring files', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github/skills/code-review'), { recursive: true });
    mkdirSync(join(root, '.github/skills/plugin-specific'), { recursive: true });
    writeFileSync(join(root, '.github/skills/code-review/notes.md'), 'repository notes\n');
    writeFileSync(join(root, '.github/skills/plugin-specific/SKILL.md'), 'repository skill\n');

    synchronize({ root, target, policyRef, mode: 'apply' });

    assert.equal(readFileSync(join(root, '.github/skills/code-review/notes.md'), 'utf8'), 'repository notes\n');
    assert.equal(readFileSync(join(root, '.github/skills/plugin-specific/SKILL.md'), 'utf8'), 'repository skill\n');
    assert.equal(existsSync(join(root, '.github/skills/code-review/SKILL.md')), true);
  } finally {
    cleanup();
  }
});

test('apply refreshes a stale managed review skill and subsequent audit is clean', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github/skills/code-review'), { recursive: true });
    writeFileSync(
      join(root, '.github/skills/code-review/SKILL.md'),
      '---\n# Managed by stuttter/.github fleet standards. Do not edit locally.\nname: code-review\ndescription: Stale managed review policy.\nlicense: GPL-2.0-or-later\n---\n\nStale content.\n',
    );

    const applied = synchronize({ root, target, policyRef, mode: 'apply' });
    assert.equal(applied.conflicts.length, 0);
    assert.equal(
      readFileSync(join(root, '.github/skills/code-review/SKILL.md'), 'utf8'),
      readFileSync(new URL('../.github/skills/code-review/SKILL.md', import.meta.url), 'utf8'),
    );

    const audited = synchronize({ root, target, policyRef, mode: 'audit' });
    assert.equal(audited.clean, true);
  } finally {
    cleanup();
  }
});

test('disabled targets do not receive the managed review skill', () => {
  const { root, cleanup } = fixture();
  try {
    const disabled = structuredClone(target);
    disabled.enabled = false;
    synchronize({ root, target: disabled, policyRef, mode: 'apply' });
    assert.equal(existsSync(join(root, '.github/skills/code-review/SKILL.md')), false);
  } finally {
    cleanup();
  }
});

test('repository-owned code-review skill is reported as a conflict and not overwritten', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github/skills/code-review'), { recursive: true });
    const localSkill = '---\nname: code-review\ndescription: Local review policy.\n---\n\nKeep this file.\n';
    writeFileSync(join(root, '.github/skills/code-review/SKILL.md'), localSkill);

    const result = synchronize({ root, target, policyRef, mode: 'apply' });

    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].path, '.github/skills/code-review/SKILL.md');
    assert.equal(readFileSync(join(root, '.github/skills/code-review/SKILL.md'), 'utf8'), localSkill);
    assert.equal(existsSync(join(root, '.github/plugin-standard.json')), false);
  } finally {
    cleanup();
  }
});

test('audit and apply reject a symbolic link in a managed path', () => {
  const { root, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'fleet-sync-outside-'));
  try {
    symlinkSync(outside, join(root, '.github'));

    const audit = synchronize({ root, target, policyRef, mode: 'audit' });
    assert.equal(audit.changes.length, 0);
    assert.equal(audit.conflicts.length, 5);
    assert.match(audit.conflicts[0].reason, /symbolic link: \.github/);

    const applied = synchronize({ root, target, policyRef, mode: 'apply' });
    assert.equal(applied.conflicts.length, 5);
    assert.equal(existsSync(join(outside, 'plugin-standard.json')), false);
    assert.equal(existsSync(join(outside, 'workflows/ci.yml')), false);
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('apply rejects a symbolic link at an individual managed file', () => {
  const { root, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'fleet-sync-outside-'));
  const sentinel = join(outside, 'sentinel.yml');
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(sentinel, 'do not replace\n');
    symlinkSync(sentinel, join(root, '.github/workflows/ci.yml'));

    const result = synchronize({ root, target, policyRef, mode: 'apply' });
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].path, '.github/workflows/ci.yml');
    assert.match(result.conflicts[0].reason, /symbolic link/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'do not replace\n');
    assert.equal(existsSync(join(root, '.github/plugin-standard.json')), false);
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an existing manifest must be reconciled rather than overwritten', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github'), { recursive: true });
    const different = structuredClone(target.manifest);
    different.minimum_php = '8.0';
    writeFileSync(join(root, '.github/plugin-standard.json'), `${JSON.stringify(different, null, 2)}\n`);
    const result = synchronize({ root, target, policyRef, mode: 'apply' });
    assert.equal(result.conflicts[0].path, '.github/plugin-standard.json');
    assert.equal(JSON.parse(readFileSync(join(root, '.github/plugin-standard.json'), 'utf8')).minimum_php, '8.0');
  } finally {
    cleanup();
  }
});

test('manifest and inventory validation reject unknown or duplicate policy', () => {
  assert.match(validateManifest({ ...target.manifest, surprise: true }).join('\n'), /unsupported key surprise/);
  assert.match(validateManifest({ ...target.manifest, $schema: 42 }).join('\n'), /\$schema must be a URI reference/);
  const { root, cleanup } = fixture();
  try {
    const path = join(root, 'inventory.json');
    writeFileSync(path, JSON.stringify({ repositories: [target, target] }));
    assert.throws(() => loadInventory(path), /duplicates stuttter\/example-plugin/);
    writeFileSync(path, JSON.stringify({ repositories: [target, { ...target, repository: 'STUTTTER/EXAMPLE-PLUGIN' }] }));
    assert.throws(() => loadInventory(path), /duplicates STUTTTER\/EXAMPLE-PLUGIN/);
    writeFileSync(path, JSON.stringify({ $schema: 42, repositories: [target] }));
    assert.throws(() => loadInventory(path), /Inventory \$schema must be a URI reference/);

    const protectedTarget = { ...target, protection: { extra_required_checks: ['Local integration'] } };
    writeFileSync(path, JSON.stringify({ repositories: [protectedTarget] }));
    assert.deepEqual(loadInventory(path).repositories[0].protection, protectedTarget.protection);

    for (const [name, protection, pattern] of [
      ['non-object', [], /protection must be an object/],
      ['unknown-key', { extra_required_checks: [], surprise: true }, /unsupported key surprise/],
      ['duplicate', { extra_required_checks: ['Gate', 'Gate'] }, /extra_required_checks is invalid/],
      ['carriage-return', { extra_required_checks: ['Gate\rname'] }, /extra_required_checks is invalid/],
      ['line-feed', { extra_required_checks: ['Gate\nname'] }, /extra_required_checks is invalid/],
    ]) {
      writeFileSync(path, JSON.stringify({ repositories: [{ ...target, protection }] }));
      assert.throws(() => loadInventory(path), pattern, name);
    }
  } finally {
    cleanup();
  }
});

test('inventory requires an ordered PHP matrix beginning at the minimum', () => {
  const unsorted = structuredClone(target);
  unsorted.manifest.php_matrix = ['8.4', '7.4'];
  const missingMinimum = structuredClone(target);
  missingMinimum.manifest.php_matrix = ['8.0', '8.4'];
  const belowMinimum = structuredClone(target);
  belowMinimum.manifest.minimum_php = '8.0';
  belowMinimum.manifest.php_matrix = ['7.4', '8.0', '8.4'];
  const { root, cleanup } = fixture();
  try {
    for (const [name, item, pattern] of [
      ['unsorted', unsorted, /ordered from oldest to newest/],
      ['missing-minimum', missingMinimum, /must include minimum_php/],
      ['below-minimum', belowMinimum, /must begin with minimum_php/],
    ]) {
      const path = join(root, `${name}.json`);
      writeFileSync(path, JSON.stringify({ repositories: [item] }));
      assert.throws(() => loadInventory(path), pattern);
    }
  } finally {
    cleanup();
  }
});

test('enabled inventory repositories cannot regress below the WordPress 6.4 baseline', () => {
  const legacy = structuredClone(target);
  legacy.manifest.minimum_wordpress = '6.3';
  const disabledLegacy = structuredClone(legacy);
  disabledLegacy.enabled = false;
  const { root, cleanup } = fixture();
  const path = join(root, 'inventory.json');
  try {
    writeFileSync(path, JSON.stringify({ repositories: [legacy] }));
    assert.throws(() => loadInventory(path), /minimum_wordpress must be 6\.4 or newer/);

    writeFileSync(path, JSON.stringify({ repositories: [disabledLegacy] }));
    assert.doesNotThrow(() => loadInventory(path));
  } finally {
    cleanup();
  }
});

test('enabled inventory repositories cannot regress below the PHP 7.4 baseline', () => {
  const legacy = structuredClone(target);
  legacy.manifest.minimum_php = '7.3';
  legacy.manifest.php_matrix = ['7.3', '8.4'];
  const { root, cleanup } = fixture();
  const path = join(root, 'inventory.json');
  try {
    writeFileSync(path, JSON.stringify({ repositories: [legacy] }));
    assert.throws(() => loadInventory(path), /minimum_php must be 7\.4 or newer/);
  } finally {
    cleanup();
  }
});

test('managed paths are explicit and WordPress.org release callers require WordPress.org', () => {
  const githubOnly = structuredClone(target);
  githubOnly.manifest.wordpress_org = false;
  githubOnly.managed_paths = ['ci', 'dependabot'];
  const { root, cleanup } = fixture();
  try {
    const result = synchronize({ root, target: githubOnly, policyRef, mode: 'apply' });
    assert.equal(existsSync(join(root, '.github/workflows/release.yml')), false);
    assert.deepEqual(result.changes.map(({ path }) => path), [
      '.github/plugin-standard.json',
      '.github/skills/code-review/SKILL.md',
      '.github/workflows/ci.yml',
      '.github/dependabot.yml',
    ]);

    githubOnly.managed_paths.push('release');
    const path = join(root, 'invalid-release.json');
    writeFileSync(path, JSON.stringify({ repositories: [githubOnly] }));
    assert.throws(() => loadInventory(path), /cannot manage a WordPress\.org release caller/);
  } finally {
    cleanup();
  }
});

test('rendered callers pin policy and explicitly map centrally scoped WordPress.org secrets', () => {
  const { root, cleanup } = fixture();
  try {
    synchronize({ root, target, policyRef, mode: 'apply' });
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(ci, /wordpress-plugin-ci\.yml@a{40}/);
    assert.match(release, /wordpress-plugin-release\.yml@a{40}/);
    assert.doesNotMatch(release, /secrets:\s+inherit/);
    assert.match(release, /STUTTTER_WORDPRESS_ORG_USERNAME: \$\{\{ secrets\.WORDPRESS_ORG_USERNAME \}\}/);
    assert.match(release, /STUTTTER_WORDPRESS_ORG_PASSWORD: \$\{\{ secrets\.WORDPRESS_ORG_PASSWORD \}\}/);
    assert.doesNotMatch(release, /^      WORDPRESS_ORG_(?:USERNAME|PASSWORD):/m);
  } finally {
    cleanup();
  }
});

test('manifest comparison ignores property order and an optional schema URI', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github'), { recursive: true });
    const reordered = {
      php_matrix: target.manifest.php_matrix,
      $schema: 'https://example.test/plugin-standard.schema.json',
      ...target.manifest,
    };
    writeFileSync(join(root, '.github/plugin-standard.json'), `${JSON.stringify(reordered, null, 2)}\n`);
    const result = synchronize({ root, target, policyRef, mode: 'apply' });
    assert.equal(result.conflicts.length, 0);
  } finally {
    cleanup();
  }
});
