import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    ['deploy.yml', 'uses: 10UP/Action-WordPress-Plugin-Deploy@stable\n'],
    ['fork.yml', 'uses: example/action-wordpress-plugin-deploy@v2\n'],
    ['assets.yaml', 'uses: 10up/action-wordpress-plugin-asset-update@stable\n'],
    ['custom.yml', 'run: svn commit https://plugins.svn.wordpress.org/example-plugin\n'],
    ['options.yml', 'run: svn --non-interactive --username "$U" --password "$P" commit -m release\n'],
    ['continued.yml', 'run: |\n  svn --non-interactive \\\n    commit -m release\n'],
    ['folded.yml', 'run: >\n  svn --non-interactive\n  commit -m release\n'],
    ['aliases.yml', 'run: svn rm https://plugins.svn.wordpress.org/example-plugin/tags/1.0 -m cleanup\n'],
    ['git-svn.yml', 'run: git svn dcommit\n'],
    ['svnmucc.yml', 'run: svnmucc put artifact.zip https://plugins.svn.wordpress.org/example-plugin/trunk/artifact.zip\n'],
    ['list-step.yml', 'steps:\n  - run: svn commit -m release\n'],
    ['message-option.yml', 'run: svn -m release commit https://plugins.svn.wordpress.org/example-plugin\n'],
    ['file-option.yml', 'run: svn --file message.txt commit https://plugins.svn.wordpress.org/example-plugin\n'],
    ['path.yml', 'run: /usr/bin/svn commit -m release\n'],
    ['resolved-path.yml', 'run: "$(command -v svn)" ci -m release\n'],
    ['prop-alias.yml', 'run: svn ps stable_tag 1.0 https://plugins.svn.wordpress.org/example-plugin/trunk\n'],
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows', name), workflow);
      assert.throws(
        () => verifyManifestPolicy(inventory, 'example/plugin', root),
        /contains a direct WordPress\.org publisher/u,
      );
    } finally {
      cleanup();
    }
  }
});

test('manifest policy scans the managed release caller for appended publishers', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/release.yml'), 'uses: 10up/action-wordpress-plugin-deploy@stable\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /release\.yml contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy scans local composite actions for direct publishers', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github/actions/deploy'), { recursive: true });
    writeFileSync(join(root, '.github/actions/deploy/action.yml'), 'runs:\n  steps:\n    - uses: 10up/action-wordpress-plugin-deploy@stable\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy follows local actions outside the conventional directory', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, 'deploy'), { recursive: true });
    writeFileSync(join(root, 'deploy/action.yml'), 'runs:\n  steps:\n    - uses: example/action-wordpress-plugin-asset-update@v1\n');
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./deploy\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /deploy\/action\.yml contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy follows a local action at the repository root', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, 'action.yml'), 'runs:\n  steps:\n    - run: svn commit -m release\n');
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /action\.yml contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects local action paths that explicitly escape the repository', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./../outside\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /escapes the repository root/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects linked local action definitions', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, 'outside.yml'), 'runs:\n  steps:\n    - run: svn commit -m release\n');
    mkdirSync(join(root, 'deploy'));
    symlinkSync(join(root, 'outside.yml'), join(root, 'deploy/action.yml'));
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./deploy\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /deploy\/action\.yml must be a regular in-repository action definition/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects unresolved run aliases', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/alias.yml'), 'steps:\n  - run: *publish\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /Workflow run aliases are unsupported/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects non-regular workflow definitions', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, 'outside.yml'), 'uses: 10up/action-wordpress-plugin-deploy@stable\n');
    symlinkSync(join(root, 'outside.yml'), join(root, '.github/workflows/linked.yml'));
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /linked\.yml must not be a symbolic link/u,
    );
  } finally {
    cleanup();
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

test('manifest policy allows read-only Subversion inspection in managed repositories', () => {
  for (const workflow of [
    'run: svn --non-interactive info https://plugins.svn.wordpress.org/example-plugin\n',
    'run: svn export --quiet https://develop.svn.wordpress.org/tags/6.4/tests/phpunit/includes/ /tmp/wp-tests && rm -rf /tmp/wp-tests/.svn\n',
    'run: svn checkout https://plugins.svn.wordpress.org/example-plugin/trunk ci-cache\n',
    'run: |\n  command -v svn\n  rm -rf /tmp/wp-tests/.svn\n',
    'run: curl -sO https://plugins.svn.wordpress.org/example-plugin/trunk/readme.txt # CI\n',
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows/audit.yml'), workflow);
      assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
    } finally {
      cleanup();
    }
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
