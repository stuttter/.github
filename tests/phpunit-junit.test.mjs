import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const validator = fileURLToPath(new URL('../scripts/validate-phpunit-junit.php', import.meta.url));

function validate(source) {
  const root = mkdtempSync(join(tmpdir(), 'phpunit-junit-'));
  const path = join(root, 'junit.xml');
  writeFileSync(path, source);
  const result = spawnSync('php', [validator, path], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  return result;
}

test('bounded JUnit validation accepts a real testcase', () => {
  const result = validate('<?xml version="1.0"?><testsuites><testsuite tests="1"><testcase name="works"/></testsuite></testsuites>\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executed 1 non-skipped test/u);
});

test('bounded JUnit validation rejects the zero-test bypass', () => {
  const result = validate('<?xml version="1.0"?><testsuites tests="0"/>\n');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at least one non-skipped test/u);
});

test('bounded JUnit validation rejects an all-skipped suite', () => {
  const result = validate('<?xml version="1.0"?><testsuites><testsuite tests="2" skipped="2"><testcase name="one"><skipped/></testcase><testcase name="two"><skipped message="not available"/></testcase></testsuite></testsuites>\n');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at least one non-skipped test/u);
});

test('bounded JUnit validation accepts a mixed suite with one executed testcase', () => {
  const result = validate('<?xml version="1.0"?><testsuites><testsuite tests="2" skipped="1"><testcase name="one"><skipped/></testcase><testcase name="two"/></testsuite></testsuites>\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executed 1 non-skipped test/u);
});

test('bounded JUnit validation rejects malformed and oversized output', () => {
  assert.equal(validate('<testsuites>').status, 2);
  assert.equal(validate(`<testsuites>${' '.repeat(1048576)}</testsuites>`).status, 2);
});
