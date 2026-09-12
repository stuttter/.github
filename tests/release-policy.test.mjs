import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/wordpress-plugin-release.yml', import.meta.url), 'utf8');

test('release authorization hard-codes its protected environment and binds its branch', () => {
  assert.match(workflow, /^    environment: wordpress\.org$/m);
  assert.doesNotMatch(workflow, /\$\{\{ inputs\.environment \}\}/);
  assert.doesNotMatch(workflow, /RELEASE_ENVIRONMENT/);
  assert.equal((workflow.match(/test "\$\{RELEASE_BRANCH\}" = "\$\{expected_branch\}"/g) || []).length, 2);
});

test('legacy release callers may pass an ignored environment input during migration', () => {
  const interfaceBlock = workflow.slice(0, workflow.indexOf('\nconcurrency:'));
  assert.match(interfaceBlock, /^      environment:$/m);
  assert.match(interfaceBlock, /Deprecated compatibility input\. Publishing always uses the wordpress\.org environment\./);
});

test('release inputs enforce canonical SemVer and WordPress.org eligibility', () => {
  assert.match(workflow, /\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/);
  assert.equal((workflow.match(/test "\$\{actual_wordpress_org\}" = 'true'/g) || []).length, 2);
});

test('WordPress.org credentials are explicit required caller secrets', () => {
  const interfaceBlock = workflow.slice(0, workflow.indexOf('\nconcurrency:'));
  const secretsBlock = interfaceBlock.slice(interfaceBlock.indexOf('    secrets:'));
  const secretNames = [...secretsBlock.matchAll(/^      ([A-Z0-9_]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(secretNames, ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD']);
  assert.match(interfaceBlock, /^      WORDPRESS_ORG_USERNAME:$/m);
  assert.match(interfaceBlock, /^      WORDPRESS_ORG_PASSWORD:$/m);
  assert.equal((interfaceBlock.match(/^        required: true$/gm) || []).length, 4);
});
