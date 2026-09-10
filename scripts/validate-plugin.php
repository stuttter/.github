<?php

/**
 * Validate a plugin repository's machine-readable and WordPress metadata.
 *
 * Usage: php validate-plugin.php [repository-path] [expected-version]
 */

declare(strict_types=1);

$root             = realpath($argv[1] ?? getcwd());
$expected_version = $argv[2] ?? null;
$errors           = array();

if (false === $root) {
	fwrite(STDERR, "Repository path does not exist.\n");
	exit(2);
}

$manifest_path = $root . '/.github/plugin-standard.json';
if (! is_file($manifest_path)) {
	fwrite(STDERR, "Missing .github/plugin-standard.json.\n");
	exit(1);
}

try {
	$manifest = json_decode((string) file_get_contents($manifest_path), true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $exception) {
	fwrite(STDERR, 'Invalid plugin manifest JSON: ' . $exception->getMessage() . "\n");
	exit(1);
}

$required = array(
	'slug',
	'main_file',
	'risk',
	'minimum_php',
	'minimum_wordpress',
	'tested_wordpress',
	'wordpress_org',
	'multisite',
);

foreach ($required as $key) {
	if (! array_key_exists($key, $manifest)) {
		$errors[] = "Manifest is missing required key: {$key}.";
	}
}

if ($errors) {
	fwrite(STDERR, implode("\n", $errors) . "\n");
	exit(1);
}

if (! in_array($manifest['risk'], array('standard', 'elevated', 'critical'), true)) {
	$errors[] = 'Manifest risk must be standard, elevated, or critical.';
}

if (! preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/', (string) $manifest['slug'])) {
	$errors[] = 'Manifest slug is invalid.';
}

if (basename((string) $manifest['main_file']) !== $manifest['main_file']) {
	$errors[] = 'Manifest main_file must be a root-level PHP filename.';
}

$plugin_path = $root . '/' . $manifest['main_file'];
if (! is_file($plugin_path)) {
	$errors[] = "Plugin entry file does not exist: {$manifest['main_file']}.";
} else {
	$plugin_source = (string) file_get_contents($plugin_path);
	$headers       = array(
		'Plugin Name' => null,
		'Version'     => null,
		'Requires PHP' => null,
		'Text Domain' => null,
	);

	foreach ($headers as $name => $_value) {
		if (preg_match('/^[ \t*#@]*' . preg_quote($name, '/') . ':\s*(.+)$/mi', $plugin_source, $match)) {
			$headers[$name] = trim($match[1]);
		}
	}

	foreach (array('Plugin Name', 'Version', 'Requires PHP', 'Text Domain') as $name) {
		if (empty($headers[$name])) {
			$errors[] = "Plugin header is missing {$name}.";
		}
	}

	if ($headers['Requires PHP'] && $headers['Requires PHP'] !== $manifest['minimum_php']) {
		$errors[] = "Requires PHP ({$headers['Requires PHP']}) does not match manifest minimum_php ({$manifest['minimum_php']}).";
	}

	if ($headers['Text Domain'] && $headers['Text Domain'] !== $manifest['slug']) {
		$errors[] = "Text Domain ({$headers['Text Domain']}) does not match slug ({$manifest['slug']}).";
	}

	if ($expected_version && $headers['Version'] !== $expected_version) {
		$errors[] = "Plugin Version ({$headers['Version']}) does not match expected version ({$expected_version}).";
	}
}

$readme_path = $root . '/readme.txt';
if ($manifest['wordpress_org'] && ! is_file($readme_path)) {
	$errors[] = 'WordPress.org plugin is missing readme.txt.';
} elseif (is_file($readme_path)) {
	$readme  = (string) file_get_contents($readme_path);
	$fields  = array(
		'Requires at least' => $manifest['minimum_wordpress'],
		'Tested up to'      => $manifest['tested_wordpress'],
		'Requires PHP'      => $manifest['minimum_php'],
	);

	foreach ($fields as $name => $expected) {
		if (! preg_match('/^' . preg_quote($name, '/') . ':\s*(.+)$/mi', $readme, $match)) {
			$errors[] = "readme.txt is missing {$name}.";
		} elseif (trim($match[1]) !== $expected) {
			$errors[] = "readme.txt {$name} (" . trim($match[1]) . ") does not match manifest ({$expected}).";
		}
	}

	if ($expected_version) {
		if (! preg_match('/^Stable tag:\s*(.+)$/mi', $readme, $match)) {
			$errors[] = 'readme.txt is missing Stable tag.';
		} elseif (trim($match[1]) !== $expected_version) {
			$errors[] = 'readme.txt Stable tag (' . trim($match[1]) . ") does not match expected version ({$expected_version}).";
		}

		$changelog_pattern = '/^=\s*\[?' . preg_quote($expected_version, '/') . '\]?(?=\s*(?:-|=|$))/mi';
		if (! preg_match($changelog_pattern, $readme)) {
			$errors[] = "readme.txt Changelog is missing version {$expected_version}.";
		}
	}
}

if ($errors) {
	fwrite(STDERR, implode("\n", $errors) . "\n");
	exit(1);
}

fwrite(STDOUT, "Plugin metadata is consistent.\n");
