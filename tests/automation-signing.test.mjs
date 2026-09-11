import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const codexWorkflow = readFileSync(new URL('../.github/workflows/codex-issue.yml', import.meta.url), 'utf8');

test('Codex publishing requires dedicated signing secrets', () => {
  for (const secret of ['FLEET_SIGNING_KEY', 'FLEET_SIGNING_PUBLIC_KEY', 'FLEET_SIGNING_EMAIL']) {
    assert.match(codexWorkflow, new RegExp(`${secret}:\\n {8}required: true`));
  }
});

test('Codex verifies automation commits locally and on GitHub before opening a pull request', () => {
  const publishBlock = codexWorkflow.slice(codexWorkflow.indexOf('  publish:'));
  const createPullRequest = publishBlock.indexOf('pull_request_url="$(gh pr create');

  assert.ok(createPullRequest > 0);
  assert.match(publishBlock, /git commit -S /);
  assert.match(publishBlock, /git verify-commit HEAD/);
  assert.match(publishBlock, /\.commit\.verification\.verified/);
  assert.ok(publishBlock.indexOf('git verify-commit HEAD') < createPullRequest);
  assert.ok(publishBlock.indexOf('.commit.verification.verified') < createPullRequest);
  assert.doesNotMatch(publishBlock, /^\s*git commit (?!-S\b)/m);
});

test('Codex removes an unverified pushed branch before a pull request exists', () => {
  assert.match(codexWorkflow, /push_attempted='false'/);
  assert.match(codexWorkflow, /git ls-remote --heads origin/);
  assert.match(codexWorkflow, /gh pr list/);
  assert.match(codexWorkflow, /git push origin --delete "\$\{branch\}"/);
  assert.match(codexWorkflow, /GitHub did not verify the automation signature/);
});

test('Codex boundary includes deletions and splits renames into both paths', () => {
  assert.match(codexWorkflow, /git diff HEAD --no-ext-diff --no-textconv --name-only --no-renames --diff-filter=ACDMRTUXB -z/);

  const root = mkdtempSync(join(tmpdir(), 'codex-boundary-'));
  try {
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'protected.yml'), 'protected\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture'], { cwd: root });

    renameSync(join(root, '.github', 'protected.yml'), join(root, 'allowed.txt'));
    execFileSync('git', ['add', '-N', '--all'], { cwd: root });
    const paths = execFileSync('git', ['diff', 'HEAD', '--name-only', '--no-renames', '--diff-filter=ACDMRTUXB'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n');

    assert.deepEqual(paths, ['.github/protected.yml', 'allowed.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure state records cancellations and skipped downstream publishing', () => {
  assert.match(codexWorkflow, /needs\.implement\.result != 'success' \|\| needs\.publish\.result != 'success'/);
});

test('Codex boundary rejects gitlinks as well as symbolic links', () => {
  assert.match(codexWorkflow, /git diff HEAD --no-ext-diff --no-textconv --raw --no-abbrev/);
  assert.match(codexWorkflow, /":120000"/);
  assert.match(codexWorkflow, /":160000"/);

  const root = mkdtempSync(join(tmpdir(), 'codex-symlink-'));
  try {
    symlinkSync('first-target', join(root, 'linked'));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture'], { cwd: root });
    unlinkSync(join(root, 'linked'));
    symlinkSync('second-target', join(root, 'linked'));

    const raw = execFileSync('git', ['diff', 'HEAD', '--raw', '--no-abbrev'], { cwd: root, encoding: 'utf8' });
    assert.match(raw, /^:120000 120000 /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted publishing checkout revalidates an applied artifact before signing secrets are exposed', () => {
  const applyStep = codexWorkflow.indexOf('      - name: Apply patch without running repository code');
  const validateStep = codexWorkflow.indexOf('      - name: Revalidate applied patch in trusted checkout');
  const publishStep = codexWorkflow.indexOf('      - name: Publish draft pull request');
  const validation = codexWorkflow.slice(validateStep, publishStep);

  assert.ok(applyStep >= 0 && applyStep < validateStep && validateStep < publishStep);
  assert.match(validation, /git diff --cached HEAD --check/);
  assert.match(validation, /--name-only --no-renames --diff-filter=ACDMRTUXB -z/);
  assert.match(validation, /Applied patch contains protected path/);
  assert.match(validation, /--numstat/);
  assert.match(validation, /--raw --no-abbrev/);
  assert.doesNotMatch(validation, /FLEET_SIGNING_/);
});

test('trusted revalidation detects a crafted protected-file deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-artifact-'));
  const patchPath = join(root, 'crafted.patch');
  try {
    writeFileSync(join(root, 'SECURITY.md'), 'security policy\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture'], { cwd: root });
    unlinkSync(join(root, 'SECURITY.md'));
    const patch = execFileSync('git', ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--binary', '--full-index'], { cwd: root });
    writeFileSync(patchPath, patch);
    execFileSync('git', ['restore', 'SECURITY.md'], { cwd: root });
    execFileSync('git', ['apply', '--index', patchPath], { cwd: root });

    const paths = execFileSync('git', ['diff', '--cached', 'HEAD', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '--diff-filter=ACDMRTUXB'], { cwd: root, encoding: 'utf8' });
    assert.equal(paths.trim(), 'SECURITY.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure state reports a preserved pull request when one exists', () => {
  const failureBlock = codexWorkflow.slice(codexWorkflow.indexOf('  failure-state:'));
  assert.match(failureBlock, /pull-requests: read/);
  assert.match(failureBlock, /gh pr list/);
  assert.match(failureBlock, /after preserving a draft pull request/);
  assert.match(failureBlock, /without a surviving pull request/);
});
