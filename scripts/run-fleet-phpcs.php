<?php

/**
 * Run the fleet-owned PHPCS toolchain against one enrolled plugin.
 */

declare(strict_types=1);

require_once __DIR__ . '/phpcs-standard-paths.php';

function fleet_phpcs_regular_directory(string $path, string $label): string {
	if (is_link($path)) {
		throw new RuntimeException($label . ' must not be a symbolic link.');
	}

	$real = realpath($path);
	if ($real === false || ! is_dir($real)) {
		throw new RuntimeException($label . ' does not exist.');
	}

	return $real;
}

function fleet_phpcs_regular_file(string $path, string $label): string {
	if (is_link($path)) {
		throw new RuntimeException($label . ' must not be a symbolic link.');
	}

	$real = realpath($path);
	if ($real === false || ! is_file($real)) {
		throw new RuntimeException($label . ' does not exist.');
	}

	return $real;
}

function fleet_phpcs_valid_minimum_php($value): bool {
	return is_string($value)
		&& preg_match('/^[0-9]+\.[0-9]+$/D', $value) === 1
		&& version_compare($value, '7.4', '>=');
}

function fleet_phpcs_encode_baseline(array $counts): string {
	$value = $counts === array() ? (object) array() : $counts;
	return json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
}

function fleet_phpcs_safe_relative_path(string $path): bool {
	if ($path === '' || $path[0] === '/' || strpos($path, '\\') !== false || preg_match('/[\x00-\x1F\x7F|]/u', $path) !== 0) {
		return false;
	}

	foreach (explode('/', $path) as $segment) {
		if ($segment === '' || $segment === '.' || $segment === '..') {
			return false;
		}
	}

	return true;
}

function fleet_phpcs_write_baseline(string $path, string $contents): void {
	$temporary = tempnam(dirname($path), '.phpcs-baseline-');
	if ($temporary === false) {
		throw new RuntimeException('Unable to create a temporary PHPCS baseline.');
	}

	try {
		$written = file_put_contents($temporary, $contents, LOCK_EX);
		if ($written !== strlen($contents)) {
			throw new RuntimeException('Unable to write the complete PHPCS baseline.');
		}
		if (! chmod($temporary, 0644)) {
			throw new RuntimeException('Unable to set PHPCS baseline permissions.');
		}
		if (! rename($temporary, $path)) {
			throw new RuntimeException('Unable to replace the PHPCS baseline atomically.');
		}
	} finally {
		if (file_exists($temporary)) {
			@unlink($temporary);
		}
	}
}

function fleet_phpcs_policy(string $standardRoot, string $repository): array {
	if (! preg_match('/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/D', $repository)) {
		throw new RuntimeException('The repository name is unsafe.');
	}

	$inventoryPath = fleet_phpcs_regular_file($standardRoot . '/portfolio/plugins.json', 'Portfolio inventory');
	$inventory = json_decode((string) file_get_contents($inventoryPath), true, 512, JSON_THROW_ON_ERROR);
	$matches = array_values(array_filter(
		$inventory['repositories'] ?? array(),
		static function ($entry) use ($repository): bool {
			return is_array($entry)
				&& ($entry['repository'] ?? null) === $repository
				&& ($entry['enabled'] ?? false) === true;
		}
	));

	if (count($matches) !== 1) {
		throw new RuntimeException('The repository must have one enabled portfolio entry.');
	}

	$manifest = $matches[0]['manifest'] ?? array();
	$slug = $manifest['slug'] ?? '';
	$minimumPhp = $manifest['minimum_php'] ?? '';
	$minimumWordPress = $manifest['minimum_wordpress'] ?? '';

	if (! is_string($slug) || preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/D', $slug) !== 1) {
		throw new RuntimeException('The portfolio text domain is unsafe.');
	}
	if (! fleet_phpcs_valid_minimum_php($minimumPhp)) {
		throw new RuntimeException('The portfolio minimum PHP version is unsafe.');
	}
	if (! is_string($minimumWordPress) || preg_match('/^[0-9]+\.[0-9]+$/D', $minimumWordPress) !== 1) {
		throw new RuntimeException('The portfolio minimum WordPress version is unsafe.');
	}

	return array(
		'slug'              => $slug,
		'minimum_php'       => $minimumPhp,
		'minimum_wordpress' => $minimumWordPress,
	);
}

function fleet_phpcs_baseline(string $path): array {
	if (fleet_phpcs_baseline_missing($path)) {
		return array();
	}
	if (! is_file($path)) {
		throw new RuntimeException('The PHPCS baseline must be a regular file.');
	}

	$source = (string) file_get_contents($path);
	$shape = json_decode($source, false, 512, JSON_THROW_ON_ERROR);
	$decoded = json_decode($source, true, 512, JSON_THROW_ON_ERROR);
	if (! is_object($shape) || ! is_array($decoded)) {
		throw new RuntimeException('The PHPCS baseline must contain an object.');
	}

	foreach ($decoded as $key => $count) {
		$separator = is_string($key) ? strrpos($key, '|') : false;
		$path = $separator === false ? '' : substr($key, 0, $separator);
		$source = $separator === false ? '' : substr($key, $separator + 1);
		if (! fleet_phpcs_safe_relative_path($path) || preg_match('/^[A-Za-z0-9_.-]+$/D', $source) !== 1) {
			throw new RuntimeException('The PHPCS baseline contains an unsafe key.');
		}
		if (! is_int($count) || $count < 0) {
			throw new RuntimeException('The PHPCS baseline contains an invalid count.');
		}
	}

	ksort($decoded);
	return $decoded;
}

function fleet_phpcs_baseline_missing(string $path): bool {
	if (is_link($path)) {
		throw new RuntimeException('The PHPCS baseline must be a regular file.');
	}

	return ! file_exists($path);
}

function fleet_phpcs_counts(array $report, string $projectRoot): array {
	$counts = array();
	foreach ($report['files'] ?? array() as $filePath => $file) {
		$real = realpath((string) $filePath);
		if ($real === false || strpos($real, $projectRoot . DIRECTORY_SEPARATOR) !== 0) {
			throw new RuntimeException('PHPCS reported a file outside the plugin root.');
		}
		$relative = str_replace(DIRECTORY_SEPARATOR, '/', substr($real, strlen($projectRoot) + 1));
		if (! fleet_phpcs_safe_relative_path($relative)) {
			throw new RuntimeException('PHPCS reported an unsafe plugin-relative path.');
		}
		foreach ($file['messages'] ?? array() as $message) {
			$source = $message['source'] ?? '';
			if (! is_string($source) || preg_match('/^[A-Za-z0-9_.-]+$/D', $source) !== 1) {
				throw new RuntimeException('PHPCS reported an unsafe source name.');
			}
			$key = $relative . '|' . $source;
			$counts[$key] = ($counts[$key] ?? 0) + 1;
		}
	}
	ksort($counts);
	return $counts;
}

function fleet_phpcs_compare(array $baseline, array $counts): array {
	$increases = array();
	foreach ($counts as $key => $count) {
		$allowed = $baseline[$key] ?? 0;
		if ($count > $allowed) {
			$increases[] = sprintf('%s increased from %d to %d.', $key, $allowed, $count);
		}
	}
	return $increases;
}

function fleet_phpcs_run(array $argv): int {
	$options = getopt('', array('project-root:', 'repository:', 'standard-root:', 'baseline-policy:', 'generate'));
	$projectRoot = fleet_phpcs_regular_directory($options['project-root'] ?? '.', 'Plugin root');
	$standardRoot = fleet_phpcs_regular_directory($options['standard-root'] ?? dirname(__DIR__), 'Portfolio standard root');
	$repository = $options['repository'] ?? '';
	if (! is_string($repository)) {
		throw new RuntimeException('The repository argument is invalid.');
	}
	$baselinePolicy = $options['baseline-policy'] ?? 'required';
	if (! is_string($baselinePolicy) || ! in_array($baselinePolicy, array('advisory', 'required'), true)) {
		throw new RuntimeException('The PHPCS baseline policy must be advisory or required.');
	}

	$policy = fleet_phpcs_policy($standardRoot, $repository);
	$toolRoot = fleet_phpcs_regular_directory($standardRoot . '/tools/phpcs', 'Fleet PHPCS toolchain');
	$binary = fleet_phpcs_regular_file($toolRoot . '/vendor/squizlabs/php_codesniffer/bin/phpcs', 'Fleet PHPCS binary');
	$ruleset = fleet_phpcs_regular_file($toolRoot . '/phpcs.xml.dist', 'Fleet PHPCS ruleset');
	$paths = implode(',', phpcs_standard_paths($toolRoot));
	if ($paths === '') {
		throw new RuntimeException('The fleet PHPCS standards could not be resolved.');
	}

	$reportPath = tempnam(sys_get_temp_dir(), 'fleet-phpcs-');
	if ($reportPath === false) {
		throw new RuntimeException('Unable to create the PHPCS report.');
	}

	$command = array(
		$binary,
		'--standard=' . $ruleset,
		'--runtime-set', 'installed_paths', $paths,
		'--runtime-set', 'text_domain', $policy['slug'],
		'--runtime-set', 'minimum_wp_version', $policy['minimum_wordpress'],
		'--runtime-set', 'testVersion', $policy['minimum_php'] . '-',
		'--report=json',
		'--report-file=' . $reportPath,
		'-q',
		$projectRoot,
	);

	$process = proc_open($command, array(1 => array('pipe', 'w'), 2 => array('pipe', 'w')), $pipes, $projectRoot);
	if (! is_resource($process)) {
		@unlink($reportPath);
		throw new RuntimeException('Unable to start PHPCS.');
	}
	$stdout = stream_get_contents($pipes[1]);
	$stderr = stream_get_contents($pipes[2]);
	fclose($pipes[1]);
	fclose($pipes[2]);
	$status = proc_close($process);

	$reportSource = (string) file_get_contents($reportPath);
	@unlink($reportPath);
	if ($status > 3) {
		throw new RuntimeException('PHPCS failed: ' . trim($stderr . "\n" . $stdout));
	}
	$report = json_decode($reportSource, true, 512, JSON_THROW_ON_ERROR);
	$counts = fleet_phpcs_counts($report, $projectRoot);
	$baselinePath = $projectRoot . '/phpcs-baseline.json';

	if (array_key_exists('generate', $options)) {
		if (is_link($baselinePath)) {
			throw new RuntimeException('The PHPCS baseline must not be a symbolic link.');
		}
		fleet_phpcs_write_baseline($baselinePath, fleet_phpcs_encode_baseline($counts));
		fwrite(STDOUT, sprintf("Recorded %d existing PHPCS violations.\n", array_sum($counts)));
		return 0;
	}

	if (fleet_phpcs_baseline_missing($baselinePath)) {
		$message = sprintf(
			"Fleet PHPCS found %d existing violations; generate and review phpcs-baseline.json before enforcement.\n",
			array_sum($counts)
		);
		fwrite($baselinePolicy === 'required' ? STDERR : STDOUT, $message);
		return $baselinePolicy === 'required' ? 2 : 0;
	}

	$baseline = fleet_phpcs_baseline($baselinePath);
	$increases = fleet_phpcs_compare($baseline, $counts);
	if ($increases !== array()) {
		fwrite($baselinePolicy === 'required' ? STDERR : STDOUT, implode("\n", $increases) . "\n");
		return $baselinePolicy === 'required' ? 1 : 0;
	}

	fwrite(STDOUT, sprintf(
		"Fleet PHPCS baseline did not increase (%d remaining, %d recorded).\n",
		array_sum($counts),
		array_sum($baseline)
	));
	return 0;
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
	try {
		exit(fleet_phpcs_run($argv));
	} catch (Throwable $error) {
		fwrite(STDERR, $error->getMessage() . "\n");
		exit(2);
	}
}
