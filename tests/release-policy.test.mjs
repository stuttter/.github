import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/wordpress-plugin-release.yml', import.meta.url), 'utf8');

test('release authorization binds environment and branch to immutable policy', () => {
  assert.match(workflow, /test "\$\{RELEASE_ENVIRONMENT\}" = 'wordpress\.org'/);
  assert.equal((workflow.match(/test "\$\{RELEASE_BRANCH\}" = "\$\{expected_branch\}"/g) || []).length, 2);
});

test('WordPress.org credentials are not part of the caller interface', () => {
  const interfaceBlock = workflow.slice(0, workflow.indexOf('\nconcurrency:'));
  assert.doesNotMatch(interfaceBlock, /WORDPRESS_ORG_(?:USERNAME|PASSWORD)/);
});
