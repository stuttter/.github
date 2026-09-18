import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/wordpress-plugin-ci.yml', import.meta.url),
  'utf8',
);
const ci = workflow;
const release = readFileSync(
  new URL('../.github/workflows/wordpress-plugin-release.yml', import.meta.url),
  'utf8',
);
const standards = readFileSync(
  new URL('../.github/workflows/standards-ci.yml', import.meta.url),
  'utf8',
);

test('quality gate checks pull requests against the immutable base commit', () => {
  const jobStart = workflow.indexOf('\n  quality:');
  const jobEnd = workflow.indexOf('\n  project-checks:', jobStart);
  const job = workflow.slice(jobStart, jobEnd);

  assert.notEqual(jobStart, -1);
  assert.notEqual(jobEnd, -1);
  assert.equal((job.match(/if: \$\{\{ github\.event_name == 'pull_request' \}\}/gu) || []).length, 3);
  assert.match(job, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(job, /git fetch --no-tags --depth=1 origin "\$\{BASE_SHA\}"/u);
  assert.match(job, /check-static-analysis-baselines\.mjs "\$\{BASE_SHA\}"/u);
  assert.match(job, /check-static-analysis-baselines\.mjs "\$\{BASE_SHA\}" --central-phpcs/u);
  assert.doesNotMatch(job, /php .*\$\{BASE_SHA\}|npm (?:ci|install)/u);
});

test('production artifacts remain gated by quality and project-specific checks', () => {
  const artifact = workflow.slice(workflow.indexOf('\n  artifact:'));
  assert.match(artifact, /needs: \[metadata, syntax, quality, project-checks, plugin-check, wordpress-integration\]/u);
});

test('shared workflows own one locked PHPCS toolchain and ignore repository PHPCS commands', () => {
  assert.match(ci, /composer install --working-dir=\.portfolio-standard\/tools\/phpcs[^\n]+--no-plugins --no-scripts/u);
  assert.match(ci, /run-fleet-phpcs\.php[^\n]+--baseline-policy=advisory/u);
  assert.doesNotMatch(ci, /for script in phpcs phpstan/u);
  assert.match(release, /composer install --working-dir=\.portfolio-standard\/tools\/phpcs[^\n]+--no-plugins --no-scripts/u);
  assert.match(release, /run-fleet-phpcs\.php[^\n]+--baseline-policy=advisory/u);
  assert.doesNotMatch(release, /for script in phpcs phpstan/u);

  const ciInstall = ci.indexOf('Install locked fleet PHPCS toolchain');
  const ciProjectInstall = ci.indexOf('Install locked development tools');
  assert.ok(ciInstall > 0 && ciInstall < ciProjectInstall);

  const releaseAudit = release.indexOf('Run fleet PHPCS audit without secrets');
  const releaseNode = release.indexOf('Verify deterministic generated assets');
  const releaseProject = release.indexOf('Run locked project checks without secrets');
  assert.ok(releaseAudit > 0 && releaseAudit < releaseNode && releaseAudit < releaseProject);
});

test('central PHPCS dependencies are audited centrally and exercised at minimum PHP', () => {
  assert.match(standards, /composer validate --strict --working-dir=tools\/phpcs/u);
  assert.match(standards, /composer install --working-dir=tools\/phpcs[^\n]+--no-plugins --no-scripts/u);
  assert.match(standards, /composer audit --working-dir=tools\/phpcs --locked/u);

  const syntaxStart = ci.indexOf('\n  syntax:');
  const syntaxEnd = ci.indexOf('\n  quality:', syntaxStart);
  const syntax = ci.slice(syntaxStart, syntaxEnd);
  assert.match(syntax, /matrix\.php == fromJSON\(inputs\.php-versions\)\[0\]/u);
  assert.match(syntax, /composer install --working-dir=\.portfolio-standard\/tools\/phpcs[^\n]+--no-plugins --no-scripts/u);
  assert.match(syntax, /composer audit --working-dir=\.portfolio-standard\/tools\/phpcs --locked/u);
  assert.match(syntax, /run-fleet-phpcs\.php[^\n]+--baseline-policy=advisory/u);
});
