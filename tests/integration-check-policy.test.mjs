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
  const enrolled = inventory.repositories
    .filter(({ integration }) => integration.plugin_check || integration.wordpress)
    .map(({ repository }) => repository);

  assert.deepEqual(enrolled, [
    'stuttter/wp-user-groups',
    'stuttter/wp-user-signups',
    'stuttter/wp-media-categories',
    'stuttter/wp-user-activity',
    'stuttter/wp-user-profiles',
    'stuttter/wp-term-images',
  ]);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-groups').integration.plugin_check, true);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-groups').integration.wordpress.sha256, '4f0069c407dcc34f19ec2bf06ce7690fae5b14e9fb1a94268519509f7a460e80');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-media-categories').integration.wordpress.sha256, '4a7e89f6edb6d0d2cf11159eeed7826f08eaf8bddf7ba0b2df9b216b0a53d3c0');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-activity').integration.plugin_check, true);
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-activity').integration.wordpress.sha256, '07399613862540df68f590baf7e16a72c87e3f087db7a357f292f295cec3ba03');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-user-profiles').integration.wordpress.sha256, 'a32d331491c3966f665f353f8f604ff50a2d304561ebc7b9db0949d4fffc4dbd');
  assert.equal(inventory.repositories.find(({ repository }) => repository === 'stuttter/wp-term-images').integration.wordpress.sha256, '55c265fcf4ea7a2de1c08a8c97af1dfc3dffdf55c5c7a9fd19ad38b3c41d8f40');
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
