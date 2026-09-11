import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { validateWorkflowPins } from '../scripts/validate-workflow-pins.mjs';

test('repository workflows, examples, and raw templates follow immutable pin policy', () => {
  assert.deepEqual(validateWorkflowPins(resolve('.'), ['.github/workflows', 'examples', 'fleet/templates']), []);
});

test('mutable refs are rejected while the raw policy template placeholder is allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-pins-'));
  try {
    mkdirSync(join(root, 'workflows'), { recursive: true });
    mkdirSync(join(root, 'fleet/templates'), { recursive: true });
    writeFileSync(join(root, 'workflows/bad.yml'), 'jobs:\n  bad:\n    steps:\n      - uses: evil/list-action@main\n      - { uses: evil/flow-action@develop }\n      - uses: docker://evil/example:latest\n      - uses: docker://safe/example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    writeFileSync(join(root, 'fleet/templates/good.yml'), 'jobs:\n  good:\n    uses: owner/repo/.github/workflows/test.yml@{{policy_ref}}\n');
    const errors = validateWorkflowPins(root, ['workflows', 'fleet/templates']);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /@main/);
    assert.match(errors[1], /@develop/);
    assert.match(errors[2], /Docker action.*:latest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
