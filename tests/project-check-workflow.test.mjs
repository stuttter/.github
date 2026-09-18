import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ci = readFileSync(new URL('../.github/workflows/wordpress-plugin-ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/wordpress-plugin-release.yml', import.meta.url), 'utf8');
const releaseChecks = release.slice(release.indexOf('\n  checks:'), release.indexOf('\n  artifact:'));
const releaseArtifact = release.slice(release.indexOf('\n  artifact:'), release.indexOf('\n  publish:'));
const releasePublish = release.slice(release.indexOf('\n  publish:'));

test('CI project matrix comes only from immutable central policy', () => {
  assert.match(ci, /project-check-policy\.mjs --repository "\$\{TARGET_REPOSITORY\}" --project-root \. >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(ci, /matrix: \$\{\{ fromJSON\(needs\.metadata\.outputs\.project-check-matrix\) \}\}/u);
  assert.doesNotMatch(ci, /plugin-standard[^\n]*(?:node|smoke|script)/u);
});

test('minimum PHP tests use a hashed config and the locked binary directly', () => {
  assert.match(ci, /php-version: \$\{\{ matrix\.php \}\}/u);
  assert.match(ci, /vendor\/bin\/phpunit --configuration "\$\{PHPUNIT_CONFIG\}" --log-junit/u);
  assert.match(ci, /composer install[^\n]+--no-plugins --no-scripts/u);
  assert.match(ci, /project-check-policy\.mjs[^\n]+--mode verify-installed/u);
  assert.match(ci, /validate-phpunit-junit\.php/u);
  assert.doesNotMatch(ci, /composer --no-interaction run-script test/u);
  assert.doesNotMatch(ci, /for script in phpcs phpstan test/u);
  assert.doesNotMatch(ci, /minimum-PHP PHPUnit does not apply/u);
});

test('credential-free release checks disable Composer plugins and scripts', () => {
  assert.match(releaseChecks, /composer install[^\n]+--no-plugins --no-scripts/u);
  assert.match(releaseChecks, /composer install --working-dir=\.portfolio-standard\/tools\/phpcs[^\n]+--no-plugins --no-scripts/u);
  assert.match(releaseChecks, /run-fleet-phpcs\.php[^\n]+--baseline-policy=advisory/u);
  assert.doesNotMatch(releaseChecks, /composer run-script "phpcs"/u);
});

test('repositories without an enrolled project suite retain a successful explicit matrix cell', () => {
  assert.match(ci, /matrix\.kind == 'none'/u);
  assert.match(ci, /No additional project-specific checks are enrolled/u);
});

test('Node assets require an exact lockfile, disabled lifecycle scripts, and a fixed approved script', () => {
  for (const workflow of [ci, release]) {
    assert.match(workflow, /test "\$\{NODE_BUILD_SCRIPT\}" = 'build:check'/u);
    assert.match(workflow, /project-check-policy\.mjs[^\n]+--mode verify/u);
    assert.match(workflow, /npm ci --ignore-scripts/u);
    assert.match(workflow, /npm run-script "\$\{NODE_BUILD_SCRIPT\}"/u);
  }
});

test('live smoke scripts run as argument-safe paths on isolated matrix runners', () => {
  assert.match(ci, /name: \$\{\{ matrix\.name \}\}/u);
  assert.match(ci, /test ! -L "\$\{SMOKE_SCRIPT\}"/u);
  assert.match(ci, /realpath "\$\{SMOKE_SCRIPT\}"/u);
  assert.match(ci, /SMOKE_SCRIPT[^\n]+\$'\\r'/u);
  assert.match(ci, /SMOKE_SCRIPT[^\n]+\$'\\n'/u);
  assert.match(ci, /project-check-policy\.mjs[^\n]+--mode verify/u);
  assert.match(ci, /bash -- "\$\{SMOKE_SCRIPT\}"/u);
  assert.doesNotMatch(ci, /(?:eval|bash -c).*SMOKE_SCRIPT/u);
});

test('release checks run the approved project contracts without credentials or artifacts', () => {
  assert.match(releaseChecks, /project-check-policy\.mjs --repository "\$\{TARGET_REPOSITORY\}" --project-root \. >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(releaseChecks, /steps\.project-policy\.outputs\.node_enabled == 'true'/u);
  assert.match(releaseChecks, /node-version: \$\{\{ steps\.project-policy\.outputs\.node_version \}\}/u);
  assert.match(releaseChecks, /phpunit_enabled == 'true'/u);
  assert.match(releaseChecks, /vendor\/bin\/phpunit --configuration/u);
  assert.doesNotMatch(releaseChecks, /for script in phpcs phpstan test/u);
  assert.doesNotMatch(releaseChecks, /secrets\.|build-plugin\.sh|upload-artifact/u);
});

test('release artifacts come from a fresh exact-SHA checkout with no project execution', () => {
  assert.match(releaseArtifact, /needs: checks/u);
  assert.match(releaseArtifact, /ref: \$\{\{ inputs\.commit \}\}/u);
  assert.match(releaseArtifact, /persist-credentials: false/u);
  assert.match(releaseArtifact, /test "\$\(git rev-parse HEAD\)" = "\$\{EXPECTED_COMMIT\}"/u);
  assert.match(releaseArtifact, /git fetch --no-tags origin "\$\{RELEASE_BRANCH\}"/u);
  assert.match(releaseArtifact, /test "\$\(git rev-parse FETCH_HEAD\)" = "\$\{EXPECTED_COMMIT\}"/u);
  assert.match(releaseArtifact, /\.portfolio-policy\/scripts\/validate-plugin\.php/u);
  assert.match(releaseArtifact, /\.portfolio-policy\/scripts\/build-plugin\.sh/u);
  assert.match(releaseArtifact, /actions\/upload-artifact@/u);
  assert.doesNotMatch(releaseArtifact, /(?:npm|composer) (?:ci|install|run|run-script)|vendor\/bin|project-check-policy\.mjs|bash -- "\$\{SMOKE_SCRIPT\}"|secrets\./u);
});

test('publishing consumes only the artifact job outputs and keeps release credentials isolated', () => {
  assert.match(releasePublish, /needs: artifact/u);
  assert.match(releasePublish, /PLUGIN_SLUG: \$\{\{ needs\.artifact\.outputs\.slug \}\}/u);
  assert.match(releasePublish, /ARCHIVE: \$\{\{ needs\.artifact\.outputs\.archive \}\}/u);
  assert.match(releasePublish, /WORDPRESS_ORG_USERNAME: \$\{\{ secrets\.STUTTTER_WORDPRESS_ORG_USERNAME \}\}/u);
  assert.match(releasePublish, /WORDPRESS_ORG_PASSWORD: \$\{\{ secrets\.STUTTTER_WORDPRESS_ORG_PASSWORD \}\}/u);
  assert.doesNotMatch(releaseChecks + releaseArtifact, /STUTTTER_WORDPRESS_ORG_(?:USERNAME|PASSWORD)/u);
  assert.doesNotMatch(releasePublish, /(?:npm|composer) (?:ci|install|run|run-script)|vendor\/bin|project-check-policy\.mjs|bash -- "\$\{SMOKE_SCRIPT\}"/u);
});
