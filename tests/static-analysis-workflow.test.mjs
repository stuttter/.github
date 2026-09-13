import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/wordpress-plugin-ci.yml', import.meta.url),
  'utf8',
);

test('quality gate checks pull requests against the immutable base commit', () => {
  const jobStart = workflow.indexOf('\n  quality:');
  const jobEnd = workflow.indexOf('\n  project-checks:', jobStart);
  const job = workflow.slice(jobStart, jobEnd);

  assert.notEqual(jobStart, -1);
  assert.notEqual(jobEnd, -1);
  assert.equal((job.match(/if: \$\{\{ github\.event_name == 'pull_request' \}\}/gu) || []).length, 4);
  assert.match(job, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(job, /git fetch --no-tags --depth=1 origin "\$\{BASE_SHA\}"/u);
  assert.match(job, /check-static-analysis-baselines\.mjs "\$\{BASE_SHA\}"/u);
  assert.doesNotMatch(job, /php .*\$\{BASE_SHA\}|npm (?:ci|install)/u);
});

test('production artifacts remain gated by quality and project-specific checks', () => {
  const artifact = workflow.slice(workflow.indexOf('\n  artifact:'));
  assert.match(artifact, /needs: \[metadata, syntax, quality, project-checks\]/u);
});
