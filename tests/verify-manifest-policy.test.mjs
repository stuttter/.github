import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyManifestPolicy } from '../scripts/verify-manifest-policy.mjs';

const manifest = {
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
};
const inventory = { repositories: [{ repository: 'example/plugin', enabled: true, managed_paths: ['ci', 'release'], manifest }] };

function fixture(local = manifest) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-policy-'));
  mkdirSync(join(root, '.github'));
  mkdirSync(join(root, '.github/workflows'));
  writeFileSync(join(root, '.github/plugin-standard.json'), `${JSON.stringify({ $schema: 'https://example.test/schema.json', ...local }, null, 2)}\n`);
  writeFileSync(join(root, '.github/workflows/release.yml'), '# Managed release caller.\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('manifest policy accepts the exact centrally declared metadata', () => {
  const { root, cleanup } = fixture();
  try {
    assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
  } finally {
    cleanup();
  }
});

test('manifest policy rejects direct WordPress.org publishers outside the managed release caller', () => {
  for (const [name, workflow] of [
    ['deploy.yml', 'uses: 10up/action-wordpress-plugin-deploy@stable\n'],
    ['assets.yaml', 'uses: 10up/action-wordpress-plugin-asset-update@stable\n'],
    ['custom.yml', 'run: svn commit https://plugins.svn.wordpress.org/example-plugin\n'],
    ['svnmucc.yml', 'run: svnmucc put artifact.zip https://plugins.svn.wordpress.org/example-plugin/trunk/artifact.zip\n'],
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows', name), workflow);
      assert.throws(
        () => verifyManifestPolicy(inventory, 'example/plugin', root),
        new RegExp(`${name} contains a direct WordPress\\.org publisher`),
      );
    } finally {
      cleanup();
    }
  }
});

test('manifest policy leaves repository-owned workflows alone when release is not centrally managed', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/deploy.yml'), 'uses: 10up/action-wordpress-plugin-deploy@stable\n');
    const unmanaged = structuredClone(inventory);
    unmanaged.repositories[0].managed_paths = ['ci'];
    assert.doesNotThrow(() => verifyManifestPolicy(unmanaged, 'example/plugin', root));
  } finally {
    cleanup();
  }
});

test('manifest policy rejects stale local compatibility metadata', () => {
  const { root, cleanup } = fixture({ ...manifest, minimum_wordpress: '5.2' });
  try {
    assert.throws(() => verifyManifestPolicy(inventory, 'example/plugin', root), /differs from the immutable portfolio inventory/u);
  } finally {
    cleanup();
  }
});
