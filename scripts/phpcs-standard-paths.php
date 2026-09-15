<?php

/**
 * Resolve locked PHPCS standard packages without running Composer plugins.
 */

declare(strict_types=1);

function phpcs_standard_paths(string $projectRoot): array {
	if (is_link($projectRoot)) {
		throw new RuntimeException('The project root must not be a symbolic link.');
	}

	$projectRoot = realpath($projectRoot);
	if ($projectRoot === false || ! is_dir($projectRoot)) {
		throw new RuntimeException('The project root does not exist.');
	}

	$lockPath = $projectRoot . '/composer.lock';
	$vendorPath = $projectRoot . '/vendor';
	if (! is_file($lockPath)) {
		throw new RuntimeException('composer.lock does not exist.');
	}
	if (is_link($vendorPath) || ! is_dir($vendorPath)) {
		throw new RuntimeException('The vendor directory must be a real directory.');
	}

	$vendorRoot = realpath($vendorPath);
	if ($vendorRoot === false) {
		throw new RuntimeException('The vendor directory cannot be resolved.');
	}

	$lock = json_decode((string) file_get_contents($lockPath), true, 512, JSON_THROW_ON_ERROR);
	$packages = array_merge($lock['packages'] ?? array(), $lock['packages-dev'] ?? array());
	$paths = array();

	foreach ($packages as $package) {
		if (($package['type'] ?? '') !== 'phpcodesniffer-standard') {
			continue;
		}

		$name = $package['name'] ?? '';
		if (! is_string($name) || ! preg_match('/^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/D', $name)) {
			throw new RuntimeException('A locked PHPCS standard has an unsafe package name.');
		}

		$scopePath = $vendorPath . '/' . strstr($name, '/', true);
		$packagePath = $vendorPath . '/' . $name;
		if (is_link($scopePath) || ! is_dir($scopePath)) {
			throw new RuntimeException('A locked PHPCS standard has an unsafe scope directory.');
		}
		if (is_link($packagePath) || ! is_dir($packagePath)) {
			throw new RuntimeException('A locked PHPCS standard has an unsafe package directory.');
		}

		$resolved = realpath($packagePath);
		if ($resolved === false || strpos($resolved, $vendorRoot . DIRECTORY_SEPARATOR) !== 0) {
			throw new RuntimeException('A locked PHPCS standard resolves outside the vendor directory.');
		}

		$paths[] = $resolved;
	}

	return $paths;
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
	try {
		fwrite(STDOUT, implode(',', phpcs_standard_paths($argv[1] ?? '.')) . PHP_EOL);
	} catch (Throwable $error) {
		fwrite(STDERR, $error->getMessage() . PHP_EOL);
		exit(2);
	}
}
