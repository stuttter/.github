import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateNotes, verifyRelease, writeNotes } from '../scripts/reviewed-release-notes.mjs';

const hash = (notes) => createHash('sha256').update(notes, 'utf8').digest('hex');
const notes = '# Changes\n\nCorrect avatar URLs. Caf\u00e9.\n';
const workflow = readFileSync(new URL('../.github/workflows/wordpress-plugin-release.yml', import.meta.url), 'utf8');
const helper = fileURLToPath(new URL('../scripts/reviewed-release-notes.mjs', import.meta.url));
const record = () => ({ body: notes, name: '2.0.1', tagName: '2.0.1', isDraft: false, isPrerelease: false });

test('reviewed notes preserve every UTF-8 byte and real paragraph break', () => {
  assert.deepEqual(validateNotes(notes, hash(notes)), Buffer.from(notes));
  const literal = 'Example: \\n, $(), and ${{ inputs.version }}.\n';
  assert.deepEqual(validateNotes(literal, hash(literal)), Buffer.from(literal));
  assert.throws(() => validateNotes(notes.trim(), hash(notes)));
  assert.throws(() => validateNotes(notes.replaceAll('\n', '\r\n'), hash(notes)));
  assert.throws(() => validateNotes(notes + 'Changed.', hash(notes)));
});

test('missing, malformed, or noncanonical notes fail closed', () => {
  for (const value of [undefined, '', ' \n', '\0', '\uFEFFNotes', '\uD800', 'a'.repeat(60001)]) {
    assert.throws(() => validateNotes(value, typeof value === 'string' ? hash(value) : '0'.repeat(64)));
  }
  for (const digest of [undefined, '', 'bad', hash(notes).toUpperCase(), '0'.repeat(64)]) {
    assert.throws(() => validateNotes(notes, digest));
  }
});

test('notes are written unchanged only after validation and never overwrite a file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-notes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'notes.md');
  assert.throws(() => writeNotes(path, notes, '0'.repeat(64)));
  assert.equal(existsSync(path), false);
  writeNotes(path, notes, hash(notes));
  assert.deepEqual(readFileSync(path), Buffer.from(notes));
  assert.throws(() => writeNotes(path, notes, hash(notes)));
});

test('existing and published releases must match exact reviewed prose and metadata', () => {
  assert.doesNotThrow(() => verifyRelease(record(), notes, hash(notes), '2.0.1'));
  for (const change of [
    { body: notes.trim() }, { body: notes + 'Unreviewed.' }, { name: 'Different' },
    { tagName: '2.0.2' }, { isDraft: true }, { isPrerelease: true },
  ]) {
    assert.throws(() => verifyRelease({ ...record(), ...change }, notes, hash(notes), '2.0.1'));
  }
  assert.throws(() => verifyRelease(null, notes, hash(notes), '2.0.1'));
});

test('CLI rejects missing notes without credentials and accepts the exact digest', () => {
  const run = (env) => spawnSync(process.execPath, [helper, 'validate'], { encoding: 'utf8', env });
  assert.notEqual(run({}).status, 0);
  assert.notEqual(run({ RELEASE_NOTES: notes, RELEASE_NOTES_SHA256: '0'.repeat(64) }).status, 0);
  assert.equal(run({ RELEASE_NOTES: notes, RELEASE_NOTES_SHA256: hash(notes) }).status, 0);
});

test('release workflow validates before approval and publishes only the reviewed file', () => {
  const checks = workflow.slice(workflow.indexOf('\n  checks:'), workflow.indexOf('\n  artifact:'));
  const publisher = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(checks, /reviewed-release-notes\.mjs validate/u);
  assert.doesNotMatch(checks, /secrets\.|GH_TOKEN/u);
  assert.match(publisher, /environment: wordpress\.org/u);
  assert.match(publisher, /reviewed-release-notes\.mjs write/u);
  assert.match(publisher, /--notes-file "\$\{RUNNER_TEMP\}\/reviewed-release-notes\.md"/u);
  assert.doesNotMatch(workflow, /--generate-notes|--notes-from-tag/u);
  assert.ok(publisher.indexOf('existing-release.json') < publisher.indexOf('gh release upload'));
  assert.ok(publisher.indexOf('published-release.json') < publisher.indexOf('svn commit'));
});

test('managed and example callers accept exact notes and their digest', () => {
  for (const path of ['../fleet/templates/release.yml', '../examples/release-caller.yml']) {
    const caller = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(caller, /release-notes: \$\{\{ inputs\.notes \}\}/u);
    assert.match(caller, /release-notes-sha256: \$\{\{ inputs\.notes_sha256 \}\}/u);
  }
});
