import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveIntegrationPolicy,
  validateIntegrationPolicy,
  verifyWordPressSmoke,
} from '../scripts/integration-check-policy.mjs';

const smokePath = 'tests/integration/smoke.php';
const smokeSource = '<?php\n';
const wordpress = () => ({
  path: smokePath,
  sha256: createHash('sha256').update(smokeSource).digest('hex'),
});

function target(repository, integration = {}, multisite = false) {
  return {
    repository,
    integration,
    manifest: {
      minimum_php: '7.4',
      minimum_wordpress: '6.4',
      multisite,
    },
  };
}

test('undeclared integration produces one inert matrix cell', () => {
  const policy = resolveIntegrationPolicy({ repositories: [target('example/plugin')] }, 'example/plugin');

  assert.equal(policy.pluginCheck, false);
  assert.deepEqual(policy.matrix.include, [{
    name: 'WordPress integration not declared',
    target: 'disabled',
    wordpress: '',
    php: '',
    topology: 'disabled',
  }]);
});

test('single-site policy schedules oldest, stable, and trunk', () => {
  const policy = resolveIntegrationPolicy({
    repositories: [target('example/plugin', { plugin_check: true, wordpress: wordpress() })],
  }, 'example/plugin');

  assert.equal(policy.pluginCheck, true);
  assert.deepEqual(policy.matrix.include.map(({ target: name }) => name), ['oldest', 'stable', 'trunk']);
  assert.deepEqual(policy.matrix.include.map(({ wordpress }) => wordpress), ['6.4', 'latest', 'trunk']);
  assert.deepEqual(policy.matrix.include.map(({ php }) => php), ['7.4', '8.4', '8.4']);
  assert.ok(policy.matrix.include.every(({ topology }) => topology === 'single-site'));
});

test('multisite declaration controls every WordPress integration cell', () => {
  const policy = resolveIntegrationPolicy({
    repositories: [target('example/network-plugin', { wordpress: wordpress() }, true)],
  }, 'example/network-plugin');

  assert.ok(policy.matrix.include.every(({ topology }) => topology === 'multisite'));
});

test('integration policy rejects arbitrary keys and false declarations', () => {
  assert.match(validateIntegrationPolicy({ command: 'npm run surprise' }).join('\n'), /unsupported key command/u);
  assert.match(validateIntegrationPolicy({ wordpress: false }).join('\n'), /wordpress must be an object when declared/u);
  assert.match(validateIntegrationPolicy({ wordpress: { path: '../smoke.php', sha256: 'a'.repeat(64) } }).join('\n'), /path must be tests\/integration\/smoke\.php/u);
  assert.match(validateIntegrationPolicy({ wordpress: { path: smokePath, sha256: 'A'.repeat(64) } }).join('\n'), /lowercase SHA-256/u);
  assert.match(validateIntegrationPolicy(null).join('\n'), /must be an object/u);
});

test('WordPress smoke enrollment verifies the exact regular payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'integration-policy-'));
  const integration = join(root, 'tests', 'integration');
  mkdirSync(integration, { recursive: true });
  writeFileSync(join(integration, 'smoke.php'), smokeSource);
  try {
    assert.doesNotThrow(() => verifyWordPressSmoke(root, wordpress()));
    writeFileSync(join(integration, 'smoke.php'), '<?php // changed\n');
    assert.throws(() => verifyWordPressSmoke(root, wordpress()), /does not match its centrally approved SHA-256/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('WordPress smoke enrollment rejects missing files and symbolic links', () => {
  const root = mkdtempSync(join(tmpdir(), 'integration-policy-'));
  const integration = join(root, 'tests', 'integration');
  mkdirSync(integration, { recursive: true });
  try {
    assert.throws(() => verifyWordPressSmoke(root, wordpress()), /is missing/u);
    const outside = join(root, 'outside.php');
    writeFileSync(outside, smokeSource);
    symlinkSync(outside, join(integration, 'smoke.php'));
    assert.throws(() => verifyWordPressSmoke(root, wordpress()), /no symbolic-link components/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('integration policy requires one exact inventory identity', () => {
  const inventory = { repositories: [target('example/plugin')] };
  assert.throws(() => resolveIntegrationPolicy(inventory, 'example/missing'), /exactly one portfolio entry/u);
  inventory.repositories.push(target('example/plugin'));
  assert.throws(() => resolveIntegrationPolicy(inventory, 'example/plugin'), /exactly one portfolio entry/u);
});

test('integration resolution rejects enabled repositories below fleet baselines', () => {
  const legacy = target('example/legacy', { wordpress: wordpress() });
  legacy.enabled = true;
  legacy.manifest.minimum_wordpress = '6.3';

  assert.throws(
    () => resolveIntegrationPolicy({ repositories: [legacy] }, legacy.repository),
    /minimum_wordpress must be 6\.4 or newer/u,
  );

  legacy.manifest.minimum_wordpress = '6.4';
  legacy.manifest.minimum_php = '7.3';
  assert.throws(
    () => resolveIntegrationPolicy({ repositories: [legacy] }, legacy.repository),
    /minimum_php must be 7\.4 or newer/u,
  );
});

test('only reviewed WordPress integration pilots are enrolled', () => {
  const inventory = JSON.parse(readFileSync(new URL('../portfolio/plugins.json', import.meta.url), 'utf8'));
  const userAvatars = inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-avatars');
  const enrolled = inventory.repositories
    .filter(({ integration }) => integration.plugin_check || integration.wordpress)
    .map(({ repository }) => repository);

  assert.deepEqual(enrolled, [
    'stuttter/wp-user-groups',
    'stuttter/wp-user-signups',
    'stuttter/wp-media-categories',
    'stuttter/wp-user-activity',
    'stuttter/wp-heart-throb',
    'stuttter/wp-user-profiles',
    'stuttter/wp-user-avatars',
    'stuttter/wp-term-images',
    'stuttter/wp-term-icons',
  ]);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-groups').integration.plugin_check, true);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-groups').integration.wordpress.sha256, '4f0069c407dcc34f19ec2bf06ce7690fae5b14e9fb1a94268519509f7a460e80');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-media-categories').integration.wordpress.sha256, '4a7e89f6edb6d0d2cf11159eeed7826f08eaf8bddf7ba0b2df9b216b0a53d3c0');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-heart-throb').integration.plugin_check, true);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-heart-throb').integration.wordpress.sha256, '545d184272e808762d34ae3072cb7a247e496149b168c9ed348053904c198952');
  assert.equal(userAvatars.enabled, true);
  assert.deepEqual(userAvatars.managed_paths, ['ci', 'release', 'dependabot']);
  assert.equal(userAvatars.checks.phpunit.config, 'phpunit.xml.dist');
  assert.deepEqual(userAvatars.checks.phpunit.files, [
    { path: 'composer.json', sha256: '3d520cbaf53c97c701ee1cb2f729bc09466f2ebb5ee262e2dde5f6e0fbfdaa39' },
    { path: 'composer.lock', sha256: '0602d3f55992efbb407e66081d9483ac370c42c7cdbe0a9a1011d8ba0df080a6' },
    { path: 'phpunit.xml.dist', sha256: '1f1877783a07ed91172dfbb0c7ce9b42c7246f5c4b5dcd7ee1d479528fe09861' },
    { path: 'tests/bootstrap.php', sha256: '92e0c9c71a5ca2e509c387968ce7ec1aa4c5e114d545922e2f5b3afb570dddfc' },
  ]);
  assert.equal(userAvatars.integration.plugin_check, true);
  assert.deepEqual(userAvatars.integration.wordpress, {
    path: 'tests/integration/smoke.php',
    sha256: 'c582368d0ddd908e6c627a12421eb1f98e7f6e2b38ffb22c4f4dd2542b4f99a6',
  });
  assert.equal(userAvatars.manifest.slug, 'wp-user-avatars');
  assert.equal(userAvatars.manifest.main_file, 'wp-user-avatars.php');
  assert.equal(userAvatars.manifest.risk, 'elevated');
  assert.equal(userAvatars.manifest.multisite, true);
  assert.equal(userAvatars.manifest.minimum_php, '7.4');
  assert.equal(userAvatars.manifest.minimum_wordpress, '6.4');
  assert.equal(userAvatars.manifest.tested_wordpress, '7.1');
  assert.equal(userAvatars.manifest.wordpress_org, true);
  assert.equal(userAvatars.manifest.release_branch, 'master');
  assert.deepEqual(userAvatars.manifest.php_matrix, ['7.4', '8.0', '8.2', '8.4']);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-activity').integration.plugin_check, true);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-activity').integration.wordpress.sha256, '07399613862540df68f590baf7e16a72c87e3f087db7a357f292f295cec3ba03');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-profiles').integration.wordpress.sha256, 'a32d331491c3966f665f353f8f604ff50a2d304561ebc7b9db0949d4fffc4dbd');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-term-images').integration.wordpress.sha256, '82499b17421227debad39b4ce094f2fd9e0de16409ea9de19400426619f7b377');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-term-icons').enabled, true);
  assert.deepEqual(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-term-icons').managed_paths, ['ci', 'release', 'dependabot']);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-term-icons').integration.plugin_check, true);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-term-icons').integration.wordpress.sha256, '7a3fdacd4090f4dbf0f2e2f7ca0b1c1e49357c8aa1476086c8bde86843396def');
  assert.equal(resolveIntegrationPolicy(inventory, 'stuttter/wp-media-categories').matrix.include[0].topology, 'single-site');
  assert.equal(resolveIntegrationPolicy(inventory, 'stuttter/wp-user-groups').matrix.include[0].topology, 'multisite');
  assert.equal(resolveIntegrationPolicy(inventory, 'stuttter/wp-user-activity').matrix.include[0].topology, 'multisite');
  const termImages = resolveIntegrationPolicy(inventory, 'stuttter/wp-term-images');
  assert.equal(termImages.pluginCheck, true);
  assert.deepEqual(termImages.matrix.include[0], {
    name: 'WordPress 6.4 / PHP 7.4 / single-site',
    target: 'oldest',
    wordpress: '6.4',
    php: '7.4',
    topology: 'single-site',
  });
});
