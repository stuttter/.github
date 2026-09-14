import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/wordpress-plugin-release.yml', import.meta.url), 'utf8');
const builder = readFileSync(new URL('../scripts/build-plugin.sh', import.meta.url), 'utf8');

test('production archives use Git ordering and UTC timestamps', () => {
  assert.match(builder, /TZ=UTC git -C "\$\{repository_path\}" archive --format=zip/);
  assert.match(builder, /--prefix="\$\{slug\}\/" --output="\$\{archive_path\}" HEAD/);
  assert.doesNotMatch(builder, /&&\s+zip\s+-/u);
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
