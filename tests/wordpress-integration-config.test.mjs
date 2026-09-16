import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWordPressIntegrationConfig } from '../scripts/configure-wordpress-integration.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-integration-'));
  const pluginDirectory = join(root, 'build', 'example-plugin');
  mkdirSync(join(root, '.github'), { recursive: true });
  mkdirSync(join(root, 'tests', 'integration'), { recursive: true });
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(join(root, '.github', 'plugin-standard.json'), '{"slug":"example-plugin"}\n');
  writeFileSync(join(root, 'tests', 'integration', 'smoke.php'), '<?php\n');
  return {
    pluginDirectory,
    root,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

test('oldest single-site configuration uses declared compatibility floors', () => {
  const value = fixture();
  try {
    const result = createWordPressIntegrationConfig({
      repositoryRoot: value.root,
      pluginDirectory: value.pluginDirectory,
      target: 'oldest',
      wordpress: '6.4',
      php: '7.4',
      topology: 'single-site',
    });

    assert.equal(result.slug, 'example-plugin');
    assert.equal(result.config.core, 'WordPress/WordPress#6.4');
    assert.equal(result.config.phpVersion, '7.4');
    assert.equal(result.config.multisite, false);
    assert.equal(result.config.autoPort, true);
    assert.equal(result.config.testsEnvironment, false);
    assert.deepEqual(result.config.plugins, [realpathSync(value.pluginDirectory)]);
    assert.equal(result.config.lifecycleScripts, undefined);
  } finally {
    value.cleanup();
  }
});

test('stable and trunk sources are fixed by their trusted matrix target', () => {
  const value = fixture();
  try {
    const stable = createWordPressIntegrationConfig({
      repositoryRoot: value.root,
      pluginDirectory: value.pluginDirectory,
      target: 'stable',
      wordpress: 'latest',
      php: '8.4',
      topology: 'multisite',
    });
    const trunk = createWordPressIntegrationConfig({
      repositoryRoot: value.root,
      pluginDirectory: value.pluginDirectory,
      target: 'trunk',
      wordpress: 'trunk',
      php: '8.4',
      topology: 'multisite',
    });

    assert.equal(stable.config.core, null);
    assert.equal(trunk.config.core, 'WordPress/WordPress#master');
    assert.equal(stable.config.multisite, true);
    assert.throws(() => createWordPressIntegrationConfig({
      repositoryRoot: value.root,
      pluginDirectory: value.pluginDirectory,
      target: 'trunk',
      wordpress: 'feature/attacker-controlled',
      php: '8.4',
      topology: 'multisite',
    }), /must use trunk/u);
  } finally {
    value.cleanup();
  }
});

test('declared WordPress integration fails clearly without the fixed smoke test', () => {
  const value = fixture();
  try {
    rmSync(join(value.root, 'tests', 'integration', 'smoke.php'));
    assert.throws(() => createWordPressIntegrationConfig({
      repositoryRoot: value.root,
      pluginDirectory: value.pluginDirectory,
      target: 'stable',
      wordpress: 'latest',
      php: '8.4',
      topology: 'single-site',
    }), /Declared integration smoke test is missing at tests\/integration\/smoke\.php/u);
  } finally {
    value.cleanup();
  }
});

test('declared WordPress integration rejects a symbolic-link smoke test', () => {
  const value = fixture();
  try {
    const smoke = join(value.root, 'tests', 'integration', 'smoke.php');
    const outside = join(value.root, 'outside.php');
    rmSync(smoke);
    writeFileSync(outside, '<?php\n');
    symlinkSync(outside, smoke);
    assert.throws(() => createWordPressIntegrationConfig({
      repositoryRoot: value.root,
      pluginDirectory: value.pluginDirectory,
      target: 'stable',
      wordpress: 'latest',
      php: '8.4',
      topology: 'single-site',
    }), /must be a regular file/u);
  } finally {
    value.cleanup();
  }
});
