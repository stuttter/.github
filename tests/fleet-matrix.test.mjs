import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectTargets } from '../scripts/fleet-matrix.mjs';

const target = {
  repository: 'stuttter/example-plugin',
  enabled: false,
  manifest: { release_branch: 'master' },
};

test('an all-disabled inventory produces an empty, valid matrix', () => {
  assert.deepEqual(selectTargets({ repositories: [target] }), { include: [] });
});

test('explicit disabled and unknown targets fail closed', () => {
  assert.throws(() => selectTargets({ repositories: [target] }, target.repository), /not an enabled portfolio target/);
  assert.throws(() => selectTargets({ repositories: [target] }, 'stuttter/unknown'), /not an enabled portfolio target/);
});

test('fleet targets carry the exact reviewed repository owner', () => {
  const stuttter = { ...target, enabled: true, owner_policy: 'stuttter-organization' };
  const jjj = { ...target, repository: 'JJJ/post-type-switcher', enabled: true, owner_policy: 'jjj-maintainer' };
  assert.deepEqual(selectTargets({ repositories: [stuttter, jjj] }), { include: [
    { repository: stuttter.repository, branch: 'master', owner: 'stuttter' },
    { repository: jjj.repository, branch: 'master', owner: 'JJJ' },
  ] });
});

test('fleet jobs gate empty matrices before expansion', () => {
  const workflow = readFileSync(new URL('../.github/workflows/fleet-standards.yml', import.meta.url), 'utf8');
  assert.match(workflow, /has_targets: \$\{\{ steps\.targets\.outputs\.has_targets \}\}/);
  assert.match(workflow, /TARGET_OWNER: \$\{\{ matrix\.target\.owner \}\}/);
  assert.match(workflow, /\.owner\.login[^\n]+TARGET_OWNER/u);
  assert.equal((workflow.match(/if: \$\{\{ needs\.matrix\.outputs\.has_targets == 'true'/g) || []).length, 2);
});
