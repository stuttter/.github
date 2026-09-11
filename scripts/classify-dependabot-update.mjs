#!/usr/bin/env node

import { isDeepStrictEqual } from 'node:util';
import {
	readFileSync,
	readdirSync,
	lstatSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROTECTED_PATHS = [
	'.github/',
	'AGENTS.md',
	'SECURITY.md',
	'scripts/',
	'phpunit.xml',
	'phpcs.xml',
	'phpstan.neon',
];

const ALLOWED_FILES = {
	composer: new Set(['composer.json', 'composer.lock']),
	npm: new Set(['package.json', 'package-lock.json']),
};

function plainObject(value) {
	return value !== null && typeof value === 'object' && ! Array.isArray(value);
}

function cloneWithout(object, keys) {
	const copy = structuredClone(object);
	for (const key of keys) {
		delete copy[key];
	}
	return copy;
}

function readJson(root, path, errors) {
	try {
		const value = JSON.parse(readFileSync(join(root, path), 'utf8'));
		if (! plainObject(value)) {
			throw new Error('top-level value must be an object');
		}
		return value;
	} catch (error) {
		errors.push({ code: 'invalid_json', path, message: `${path}: ${error.message}` });
		return null;
	}
}

function inventory(root) {
	const entries = new Map();

	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (directory === root && entry.name === '.git') {
				continue;
			}

			const absolute = join(directory, entry.name);
			const path = relative(root, absolute).split(sep).join('/');
			const stat = lstatSync(absolute);

			if (stat.isSymbolicLink()) {
				entries.set(path, { type: 'symlink' });
			} else if (stat.isDirectory()) {
				entries.set(path, { type: 'directory' });
				visit(absolute);
			} else if (stat.isFile()) {
				entries.set(path, { type: 'file', body: readFileSync(absolute), executable: Boolean(stat.mode & 0o111) });
			} else {
				entries.set(path, { type: 'special' });
			}
		}
	}

	visit(root);
	return entries;
}

function changedPaths(base, head) {
	const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
	return paths.filter((path) => {
		const before = base.get(path);
		const after = head.get(path);
		if (! before || ! after || before.type !== after.type) {
			return true;
		}
		return before.type === 'file' && (before.executable !== after.executable || ! before.body.equals(after.body));
	});
}

function parseVersion(value) {
	const match = String(value ?? '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
	return match ? match.slice(1).map(Number) : null;
}

function versionLevel(from, to) {
	const oldVersion = parseVersion(from);
	const newVersion = parseVersion(to);
	if (! oldVersion || ! newVersion) {
		return null;
	}
	if (newVersion[0] !== oldVersion[0]) {
		return newVersion[0] > oldVersion[0] ? 'major' : 'downgrade';
	}
	if (newVersion[1] !== oldVersion[1]) {
		return newVersion[1] > oldVersion[1] ? 'minor' : 'downgrade';
	}
	if (newVersion[2] !== oldVersion[2]) {
		return newVersion[2] > oldVersion[2] ? 'patch' : 'downgrade';
	}
	return 'same';
}

function safeSpecifier(specifier, version) {
	const match = String(specifier ?? '').match(/^([~^]?)(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/);
	const concrete = parseVersion(version);
	if (! match || ! concrete) return false;
	const [, operator, major, minor, patch] = match;
	if (Number(major) !== concrete[0] || Number(minor) !== concrete[1]) return false;
	if (! operator && patch === undefined) return false;
	if (! operator) return Number(patch) === concrete[2];
	return patch === undefined || concrete[2] >= Number(patch);
}

function policyResult(policy, errors) {
	if (! plainObject(policy)) {
		errors.push({ code: 'invalid_policy', message: 'Policy must be an object.' });
		return { allow_minor: false };
	}
	const unknown = Object.keys(policy).filter((key) => key !== 'allow_minor');
	if (unknown.length || ('allow_minor' in policy && typeof policy.allow_minor !== 'boolean')) {
		errors.push({ code: 'invalid_policy', message: 'Policy accepts only a boolean allow_minor property.' });
	}
	return { allow_minor: policy.allow_minor === true };
}

function recordUpdate(name, before, after, direct, policy, updates, errors) {
	const level = versionLevel(before, after);
	updates.push({ name, from: before, to: after, level: level ?? 'unclassified', direct });
	if (! level || level === 'major' || level === 'downgrade' || level === 'same' || (level === 'minor' && ! policy.allow_minor)) {
		errors.push({
			code: 'disallowed_version_change',
			dependency: name,
			message: `Cannot authorize ${name} ${before} -> ${after} under this policy.`,
		});
	}
}

function packageMap(packages, field, errors) {
	if (! Array.isArray(packages)) {
		errors.push({ code: 'invalid_lockfile', message: `${field} must be an array.` });
		return new Map();
	}
	const map = new Map();
	for (const record of packages) {
		if (! plainObject(record) || typeof record.name !== 'string' || typeof record.version !== 'string' || map.has(record.name)) {
			errors.push({ code: 'invalid_lockfile', message: `${field} contains a malformed or duplicate package record.` });
			continue;
		}
		map.set(record.name, record);
	}
	return map;
}

function composerReachable(manifest, devPackages, errors) {
	const platform = /^(?:php(?:-64bit)?|ext-|lib-|composer(?:-plugin-api|-runtime-api)?$)/;
	const queue = Object.keys(manifest['require-dev'] ?? {}).filter((name) => ! platform.test(name));
	const reachable = new Set();
	while (queue.length) {
		const name = queue.shift();
		if (reachable.has(name)) continue;
		const record = devPackages.get(name);
		if (! record) {
			errors.push({ code: 'unresolved_direct_dependency', dependency: name, message: `Direct development dependency ${name} is absent from packages-dev.` });
			continue;
		}
		reachable.add(name);
		for (const child of Object.keys(record.require ?? {})) {
			if (! platform.test(child) && devPackages.has(child)) queue.push(child);
		}
	}
	for (const name of devPackages.keys()) {
		if (! reachable.has(name)) {
			errors.push({ code: 'unreachable_lock_entry', dependency: name, message: `packages-dev entry ${name} is not reachable from require-dev.` });
		}
	}
}

function validComposerSource(record) {
	try {
		const sourceUrl = new URL(record.source?.url);
		const distUrl = new URL(record.dist?.url);
		const reference = record.source?.reference;
		const repositoryPath = sourceUrl.pathname.replace(/\.git$/, '');
		return record.source?.type === 'git'
			&& record.dist?.type === 'zip'
			&& sourceUrl.protocol === 'https:'
			&& distUrl.protocol === 'https:'
			&& sourceUrl.hostname === 'github.com'
			&& distUrl.hostname === 'api.github.com'
			&& /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryPath)
			&& typeof reference === 'string'
			&& /^[0-9a-f]{7,64}$/i.test(reference)
			&& record.dist?.reference === reference
			&& distUrl.pathname === `/repos${repositoryPath}/zipball/${reference}`;
	} catch {
		return false;
	}
}

function composerRepository(record) {
	try {
		const url = new URL(record.source?.url);
		return url.protocol === 'https:' && url.hostname === 'github.com'
			? url.pathname.replace(/\.git$/, '').toLowerCase()
			: null;
	} catch {
		return null;
	}
}

function classifyComposer(baseRoot, headRoot, policy, updates, errors) {
	const beforeManifest = readJson(baseRoot, 'composer.json', errors);
	const afterManifest = readJson(headRoot, 'composer.json', errors);
	const beforeLock = readJson(baseRoot, 'composer.lock', errors);
	const afterLock = readJson(headRoot, 'composer.lock', errors);
	if (! beforeManifest || ! afterManifest || ! beforeLock || ! afterLock) return;

	if (! plainObject(beforeManifest['require-dev']) || ! plainObject(afterManifest['require-dev'])) {
		errors.push({ code: 'invalid_manifest', message: 'composer.json must contain a require-dev object.' });
		return;
	}
	if (! isDeepStrictEqual(cloneWithout(beforeManifest, ['require-dev']), cloneWithout(afterManifest, ['require-dev']))) {
		errors.push({ code: 'unexpected_manifest_change', message: 'composer.json changed outside require-dev.' });
	}
	const beforeDirect = Object.keys(beforeManifest['require-dev']).sort();
	const afterDirect = Object.keys(afterManifest['require-dev']).sort();
	if (! isDeepStrictEqual(beforeDirect, afterDirect)) {
		errors.push({ code: 'direct_dependency_set_changed', message: 'Direct development dependencies were added or removed.' });
	}

	const beforeProd = packageMap(beforeLock.packages, 'packages', errors);
	const afterProd = packageMap(afterLock.packages, 'packages', errors);
	if (! isDeepStrictEqual([...beforeProd], [...afterProd])) {
		errors.push({ code: 'production_lock_changed', message: 'Composer production packages changed.' });
	}
	const beforeDev = packageMap(beforeLock['packages-dev'], 'packages-dev', errors);
	const afterDev = packageMap(afterLock['packages-dev'], 'packages-dev', errors);
	if (! isDeepStrictEqual([...beforeDev.keys()].sort(), [...afterDev.keys()].sort())) {
		errors.push({ code: 'dependency_graph_changed', message: 'Composer development package membership changed.' });
	}
	for (const name of afterDev.keys()) {
		if (afterProd.has(name)) {
			errors.push({ code: 'dev_to_production', dependency: name, message: `${name} appears in both production and development lock sections.` });
		}
	}

	const ignoredLockKeys = ['content-hash', 'packages-dev'];
	if (! isDeepStrictEqual(cloneWithout(beforeLock, ignoredLockKeys), cloneWithout(afterLock, ignoredLockKeys))) {
		errors.push({ code: 'unexpected_lockfile_change', message: 'composer.lock changed outside content-hash and packages-dev.' });
	}
	for (const lock of [beforeLock, afterLock]) {
		if (typeof lock['content-hash'] !== 'string' || ! /^[0-9a-f]{32}$/.test(lock['content-hash'])) {
			errors.push({ code: 'invalid_lockfile', message: 'composer.lock content-hash must be 32 lowercase hexadecimal characters.' });
		}
	}
	if (isDeepStrictEqual(beforeManifest, afterManifest) && beforeLock['content-hash'] !== afterLock['content-hash']) {
		errors.push({ code: 'unexpected_lockfile_change', message: 'Composer content-hash changed without a manifest change.' });
	}

	composerReachable(beforeManifest, beforeDev, errors);
	composerReachable(afterManifest, afterDev, errors);
	for (const name of beforeDirect) {
		const before = beforeDev.get(name);
		const after = afterDev.get(name);
		if (! before || ! after) continue;
		if (before.version !== after.version) {
			recordUpdate(name, before.version, after.version, true, policy, updates, errors);
		}
		const oldSpecifier = beforeManifest['require-dev'][name];
		const newSpecifier = afterManifest['require-dev'][name];
		if (oldSpecifier !== newSpecifier && before.version === after.version) {
			errors.push({ code: 'specifier_without_update', dependency: name, message: `${name} changed its constraint without changing its locked version.` });
		}
		if (oldSpecifier !== newSpecifier && ! safeSpecifier(newSpecifier, after.version)) {
			errors.push({ code: 'unsafe_dependency_source', dependency: name, message: `${name} changed to an unsupported or mismatched source constraint.` });
		}
	}
	for (const [name, before] of beforeDev) {
		const after = afterDev.get(name);
		if (! after || before.version !== after.version) continue;
		if (! isDeepStrictEqual(before, after)) {
			errors.push({ code: 'unexpected_lock_record_change', dependency: name, message: `${name} changed without a version change.` });
		}
	}
	for (const [name, after] of afterDev) {
		const before = beforeDev.get(name);
		if ((! before || before.version !== after.version) && (! validComposerSource(after) || composerRepository(before) !== composerRepository(after))) {
			errors.push({ code: 'unsafe_dependency_source', dependency: name, message: `Updated dependency ${name} lacks canonical Composer source and distribution provenance.` });
		}
		if ((! before || before.version !== after.version) && after.type === 'composer-plugin') {
			errors.push({ code: 'dependency_executes_install_code', dependency: name, message: `Updated dependency ${name} is a Composer plugin.` });
		}
	}
	for (const [name, before] of beforeDev) {
		const after = afterDev.get(name);
		if (after && before.version !== after.version && ! beforeDirect.includes(name)) {
			recordUpdate(name, before.version, after.version, false, policy, updates, errors);
		}
	}
	if (updates.length === 0) {
		errors.push({ code: 'no_version_update', message: 'No existing Composer development dependency version changed.' });
	}
}

function npmPackageName(path) {
	const marker = 'node_modules/';
	const index = path.lastIndexOf(marker);
	return index === -1 ? null : path.slice(index + marker.length);
}

function resolveNpmDependency(packages, parentPath, name) {
	let directory = parentPath;
	while (true) {
		const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
		if (packages.has(candidate)) return candidate;
		if (! directory) return null;
		const marker = directory.lastIndexOf('/node_modules/');
		directory = marker === -1 ? '' : directory.slice(0, marker);
	}
}

function npmReachable(packages, direct, errors) {
	const queue = direct.map((name) => resolveNpmDependency(packages, '', name));
	const reachable = new Set(['']);
	for (let index = 0; index < queue.length; index++) {
		const path = queue[index];
		if (! path || reachable.has(path)) continue;
		const record = packages.get(path);
		if (! record) continue;
		reachable.add(path);
		for (const name of Object.keys({ ...(record.dependencies ?? {}), ...(record.optionalDependencies ?? {}), ...(record.peerDependencies ?? {}) })) {
			const child = resolveNpmDependency(packages, path, name);
			if (child && ! reachable.has(child)) queue.push(child);
		}
	}
	for (const name of direct) {
		if (! resolveNpmDependency(packages, '', name)) {
			errors.push({ code: 'unresolved_direct_dependency', dependency: name, message: `Direct development dependency ${name} is absent from package-lock.json.` });
		}
	}
	for (const path of packages.keys()) {
		if (path && ! reachable.has(path)) {
			errors.push({ code: 'unreachable_lock_entry', dependency: npmPackageName(path), message: `${path} is not reachable from devDependencies.` });
		}
	}
}

function npmPackageMap(lock, errors) {
	if (lock.lockfileVersion !== 3 || ! plainObject(lock.packages)) {
		errors.push({ code: 'invalid_lockfile', message: 'package-lock.json must use lockfileVersion 3 and contain packages.' });
		return new Map();
	}
	return new Map(Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b)));
}

function validSha512Integrity(value) {
	if (typeof value !== 'string' || ! value.startsWith('sha512-')) return false;
	const digest = value.slice(7);
	try {
		const decoded = Buffer.from(digest, 'base64');
		return decoded.length === 64 && decoded.toString('base64') === digest;
	} catch {
		return false;
	}
}

function validNpmSource(name, version, resolved) {
	try {
		const url = new URL(resolved);
		const packagePath = `/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
		return url.protocol === 'https:'
			&& url.hostname === 'registry.npmjs.org'
			&& decodeURIComponent(url.pathname) === packagePath
			&& url.username === ''
			&& url.password === ''
			&& url.search === ''
			&& url.hash === '';
	} catch {
		return false;
	}
}

function classifyNpm(baseRoot, headRoot, policy, updates, errors) {
	const beforeManifest = readJson(baseRoot, 'package.json', errors);
	const afterManifest = readJson(headRoot, 'package.json', errors);
	const beforeLock = readJson(baseRoot, 'package-lock.json', errors);
	const afterLock = readJson(headRoot, 'package-lock.json', errors);
	if (! beforeManifest || ! afterManifest || ! beforeLock || ! afterLock) return;

	if (! plainObject(beforeManifest.devDependencies) || ! plainObject(afterManifest.devDependencies)) {
		errors.push({ code: 'invalid_manifest', message: 'package.json must contain a devDependencies object.' });
		return;
	}
	if (! isDeepStrictEqual(cloneWithout(beforeManifest, ['devDependencies']), cloneWithout(afterManifest, ['devDependencies']))) {
		errors.push({ code: 'unexpected_manifest_change', message: 'package.json changed outside devDependencies, including scripts or production dependencies.' });
	}
	const beforeDirect = Object.keys(beforeManifest.devDependencies).sort();
	const afterDirect = Object.keys(afterManifest.devDependencies).sort();
	if (! isDeepStrictEqual(beforeDirect, afterDirect)) {
		errors.push({ code: 'direct_dependency_set_changed', message: 'Direct development dependencies were added or removed.' });
	}

	const beforePackages = npmPackageMap(beforeLock, errors);
	const afterPackages = npmPackageMap(afterLock, errors);
	if (! isDeepStrictEqual([...beforePackages.keys()], [...afterPackages.keys()])) {
		errors.push({ code: 'dependency_graph_changed', message: 'npm package-lock membership changed.' });
	}
	const beforeRoot = beforePackages.get('');
	const afterRoot = afterPackages.get('');
	if (! plainObject(beforeRoot) || ! plainObject(afterRoot)) {
		errors.push({ code: 'invalid_lockfile', message: 'package-lock.json is missing its root package record.' });
		return;
	}
	if (! isDeepStrictEqual(cloneWithout(beforeRoot, ['devDependencies']), cloneWithout(afterRoot, ['devDependencies']))) {
		errors.push({ code: 'unexpected_lockfile_change', message: 'The package-lock root changed outside devDependencies.' });
	}
	if (! isDeepStrictEqual(beforeManifest.devDependencies, beforeRoot.devDependencies) || ! isDeepStrictEqual(afterManifest.devDependencies, afterRoot.devDependencies)) {
		errors.push({ code: 'manifest_lock_mismatch', message: 'package.json devDependencies do not match the package-lock root.' });
	}
	if (! isDeepStrictEqual(cloneWithout(beforeLock, ['packages']), cloneWithout(afterLock, ['packages']))) {
		errors.push({ code: 'unexpected_lockfile_change', message: 'package-lock.json changed outside packages.' });
	}

	for (const [path, record] of afterPackages) {
		if (! plainObject(record)) {
			errors.push({ code: 'invalid_lockfile', message: `${path || 'root'} has a malformed package record.` });
			continue;
		}
		if (path && record.dev !== true) {
			errors.push({ code: 'production_lock_changed', dependency: npmPackageName(path), message: `${path} is not marked as a development dependency.` });
		}
	}
	npmReachable(beforePackages, beforeDirect, errors);
	npmReachable(afterPackages, afterDirect, errors);

	for (const name of beforeDirect) {
		const beforePath = resolveNpmDependency(beforePackages, '', name);
		const afterPath = resolveNpmDependency(afterPackages, '', name);
		const before = beforePackages.get(beforePath);
		const after = afterPackages.get(afterPath);
		if (! before || ! after) continue;
		if (before.version !== after.version) {
			recordUpdate(name, before.version, after.version, true, policy, updates, errors);
		}
		const oldSpecifier = beforeManifest.devDependencies[name];
		const newSpecifier = afterManifest.devDependencies[name];
		if (oldSpecifier !== newSpecifier && before.version === after.version) {
			errors.push({ code: 'specifier_without_update', dependency: name, message: `${name} changed its constraint without changing its locked version.` });
		}
		if (oldSpecifier !== newSpecifier && ! safeSpecifier(newSpecifier, after.version)) {
			errors.push({ code: 'unsafe_dependency_source', dependency: name, message: `${name} changed to an unsupported or mismatched source constraint.` });
		}
	}
	for (const [path, before] of beforePackages) {
		if (! path) continue;
		const after = afterPackages.get(path);
		if (! after || before.version !== after.version) continue;
		if (! isDeepStrictEqual(before, after)) {
			errors.push({ code: 'unexpected_lock_record_change', dependency: npmPackageName(path), message: `${path} changed without a version change.` });
		}
	}
	const directPaths = new Set(beforeDirect.flatMap((name) => {
		const path = resolveNpmDependency(beforePackages, '', name);
		return path ? [path] : [];
	}));
	for (const [path, after] of afterPackages) {
		if (! path) continue;
		const before = beforePackages.get(path);
		if (! before || before.version !== after.version) {
			const name = npmPackageName(path);
			if (after.hasInstallScript === true) {
				errors.push({ code: 'dependency_executes_install_code', dependency: name, message: `Updated dependency ${name} declares an install script.` });
			}
			if (! before && ! parseVersion(after.version)) {
				errors.push({ code: 'unclassified_lock_version', dependency: name, message: `New transitive dependency ${name} does not use a stable semantic version.` });
			}
			if (after.link === true || ! validNpmSource(name, after.version, after.resolved)) {
				errors.push({ code: 'unsafe_dependency_source', dependency: name, message: `Updated dependency ${name} does not resolve from the npm registry.` });
			}
			if (! validSha512Integrity(after.integrity)) {
				errors.push({ code: 'invalid_lockfile', dependency: name, message: `Updated dependency ${name} is missing a SHA-512 integrity value.` });
			}
		}
	}
	for (const [path, before] of beforePackages) {
		if (! path) continue;
		const after = afterPackages.get(path);
		if (after && before.version !== after.version && ! directPaths.has(path)) {
			recordUpdate(npmPackageName(path), before.version, after.version, false, policy, updates, errors);
		}
	}
	if (updates.length === 0) {
		errors.push({ code: 'no_version_update', message: 'No existing npm development dependency version changed.' });
	}
}

export function classifyDependabotUpdate({ baseDir, headDir, policy = {} }) {
	const errors = [];
	const normalizedPolicy = policyResult(policy, errors);
	const baseRoot = resolve(baseDir);
	const headRoot = resolve(headDir);
	const base = inventory(baseRoot);
	const head = inventory(headRoot);
	const changes = changedPaths(base, head);

	for (const path of changes) {
		const entry = head.get(path) ?? base.get(path);
		if (entry.type === 'symlink' || entry.type === 'special' || entry.type === 'directory') {
			errors.push({ code: 'unsafe_file_type', path, message: `Changed path ${path} is a directory, symbolic link, or special file.` });
		} else if (entry.executable === true) {
			errors.push({ code: 'unsafe_file_mode', path, message: `Changed path ${path} is executable.` });
		} else if (entry.body?.includes(0)) {
			errors.push({ code: 'binary_change', path, message: `Changed path ${path} appears to be binary.` });
		}
	}

	let ecosystem = null;
	if (changes.some((path) => ALLOWED_FILES.composer.has(path))) ecosystem = 'composer';
	if (changes.some((path) => ALLOWED_FILES.npm.has(path))) {
		if (ecosystem) {
			errors.push({ code: 'multiple_ecosystems', message: 'A guarded update may change only one dependency ecosystem.' });
		} else ecosystem = 'npm';
	}
	if (! ecosystem) {
		errors.push({ code: 'no_supported_update', message: 'No supported dependency update was found.' });
	}

	if (ecosystem) {
		for (const path of changes) {
			if (! ALLOWED_FILES[ecosystem].has(path)) {
				const protectedPath = PROTECTED_PATHS.some((prefix) => path === prefix || path.startsWith(prefix));
				errors.push({
					code: protectedPath ? 'protected_path_changed' : 'unexpected_path_changed',
					path,
					message: `${path} is outside the guarded ${ecosystem} dependency boundary.`,
				});
			}
		}
	}

	const updates = [];
	if (ecosystem === 'composer') classifyComposer(baseRoot, headRoot, normalizedPolicy, updates, errors);
	if (ecosystem === 'npm') classifyNpm(baseRoot, headRoot, normalizedPolicy, updates, errors);

	return {
		schema_version: 1,
		decision: errors.length === 0 ? 'allow' : 'deny',
		class: 'dependabot-development-dependency',
		ecosystem,
		policy: normalizedPolicy,
		changed_files: changes,
		updates,
		reasons: errors,
	};
}

function parseArguments(argv) {
	const result = { policy: {} };
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (! value || ! ['--base-dir', '--head-dir', '--policy'].includes(flag)) {
			throw new Error('Usage: classify-dependabot-update.mjs --base-dir PATH --head-dir PATH [--policy FILE]');
		}
		if (flag === '--base-dir') result.baseDir = value;
		if (flag === '--head-dir') result.headDir = value;
		if (flag === '--policy') result.policy = JSON.parse(readFileSync(value, 'utf8'));
	}
	if (! result.baseDir || ! result.headDir) throw new Error('Both --base-dir and --head-dir are required.');
	return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const evidence = classifyDependabotUpdate(parseArguments(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
		process.exitCode = evidence.decision === 'allow' ? 0 : 1;
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ schema_version: 1, decision: 'deny', class: 'dependabot-development-dependency', ecosystem: null, policy: { allow_minor: false }, changed_files: [], updates: [], reasons: [{ code: 'classifier_error', message: error.message }] }, null, 2)}\n`);
		process.exitCode = 2;
	}
}
