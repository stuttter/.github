import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const resolver = fileURLToPath(new URL('../scripts/phpcs-standard-paths.php', import.meta.url));

function fixture(packages = [{ name: 'acme/coding-standard', type: 'phpcodesniffer-standard' }]) {
  const root = mkdtempSync(join(tmpdir(), 'phpcs-standard-paths-'));
  mkdirSync(join(root, 'vendor', 'acme', 'coding-standard'), { recursive: true });
  writeFileSync(join(root, 'composer.lock'), `${JSON.stringify({ packages: [], 'packages-dev': packages })}\n`);
  return root;
}

function resolvePaths(root) {
  return spawnSync('php', [resolver, root], { encoding: 'utf8' });
}

test('locked PHPCS standards resolve beneath the real vendor directory', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const result = resolvePaths(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), realpathSync(join(root, 'vendor', 'acme', 'coding-standard')));
});

test('malformed package names cannot traverse the vendor directory', (t) => {
  for (const name of ['../foo', 'foo/..', './foo', 'foo/.']) {
    const root = fixture([{ name, type: 'phpcodesniffer-standard' }]);
    t.after(() => rmSync(root, { force: true, recursive: true }));
    assert.equal(resolvePaths(root).status, 2, name);
  }
});

test('vendor, scope, and package symlinks fail closed', (t) => {
  for (const level of ['vendor', 'scope', 'package']) {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), `phpcs-standard-${level}-`));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    t.after(() => rmSync(outside, { force: true, recursive: true }));

    if (level === 'vendor') {
      rmSync(join(root, 'vendor'), { recursive: true });
      mkdirSync(join(outside, 'acme', 'coding-standard'), { recursive: true });
      symlinkSync(outside, join(root, 'vendor'));
    } else if (level === 'scope') {
      rmSync(join(root, 'vendor', 'acme'), { recursive: true });
      mkdirSync(join(outside, 'coding-standard'), { recursive: true });
      symlinkSync(outside, join(root, 'vendor', 'acme'));
    } else {
      rmSync(join(root, 'vendor', 'acme', 'coding-standard'), { recursive: true });
      symlinkSync(outside, join(root, 'vendor', 'acme', 'coding-standard'));
    }

    assert.equal(resolvePaths(root).status, 2, level);
  }
});
