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

	if ($manifest['wordpress_org']) {
		$description_offset = null;
		if (preg_match('/^== Description ==\s*$/mi', $readme, $description_match, PREG_OFFSET_CAPTURE)) {
			$description_offset = $description_match[0][1];
		}

		$short_descriptions = array();
		$preamble_headers   = array();
		if (null === $description_offset) {
			$errors[] = 'readme.txt is missing the == Description == heading.';
		} else {
			$preamble       = substr($readme, 0, $description_offset);
			$lines          = preg_split('/\R/u', $preamble) ?: array();
			$header_pattern = '/^(Contributors|Donate link|Tags|Requires at least|Tested up to|Stable tag|Requires PHP|Requires Plugins|License|License URI|Author|Author URI|Plugin URI):\s*(.*)$/iu';
			$in_headers     = true;
			$seen_header    = false;
			foreach ($lines as $line_number => $line) {
				$raw_line = $line;
				$line = preg_replace('/^[\p{Z}\s]+|[\p{Z}\s]+$/u', '', $line) ?? trim($line);
				if (0 === $line_number) {
					continue;
				}
				if ($in_headers && preg_match($header_pattern, $line, $header_match)) {
					$seen_header                                      = true;
					$preamble_headers[strtolower($header_match[1])] = trim($header_match[2]);
					continue;
				}
				if ('' === $line) {
					if ($seen_header) {
						$in_headers = false;
					}
					continue;
				}
				$in_headers = false;
				$short_descriptions[] = $raw_line;
			}
		}

		$required_preamble_headers = array('requires at least', 'tested up to', 'requires php', 'stable tag');
		$missing_preamble_headers  = array_filter(
			$required_preamble_headers,
			static fn($header) => ! isset($preamble_headers[$header]) || '' === $preamble_headers[$header]
		);
		if (null !== $description_offset && $missing_preamble_headers) {
			$errors[] = 'readme.txt required metadata headers must precede its short description.';
		}

		if (1 !== count($short_descriptions)) {
			$errors[] = 'readme.txt must contain exactly one plain-text short description after its headers and before == Description ==.';
		} else {
			$short_description = $short_descriptions[0];
			$character_count   = preg_match_all('/./us', $short_description, $characters);
			if (false === $character_count || $character_count > 150) {
				$errors[] = 'readme.txt short description must be no more than 150 characters.';
			}
			$markup_pattern = '/(?:<!--|<![^>]*>|<\?|<\/?[A-Za-z][^>]*>|!?\[[^\r\n]*\]\s*(?:\([^\r\n]*\)|\[[^\r\n]*\])|`|^(?: {4}| {0,3}\t)|^ {0,3}(?:`{3,}|~{3,})[^\r\n]*$|^ {0,3}(?:\[[^\]]+\]:\s*\S|#{1,6}(?:\s|$)|>\s?|[-+*]\s|\d+[.)]\s|=.+=$|(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$))/u';
			$has_markup     = 1 === preg_match($markup_pattern, $short_description);

			$url_spans = array();
			if (preg_match_all('/\bhttps?:\/\/\S+/iu', $short_description, $urls, PREG_OFFSET_CAPTURE)) {
				foreach ($urls[0] as $url) {
					$url_spans[] = array($url[1], $url[1] + strlen($url[0]));
				}
			}

			$delimiter_pattern = '/(?:~~(?=\S)[^\r\n]*?\S~~|\*\*(?=\S)[^\r\n]*?\S\*\*|(?<![\p{L}\p{N}])__(?=\S)[^\r\n]*?\S__(?![\p{L}\p{N}])|\*(?=\S)[^*\r\n]*?\S\*|(?<![\p{L}\p{N}_])_(?!_)(?=\S)[^\r\n]*?\S_(?![_\p{L}\p{N}]))/u';
			if (! $has_markup && preg_match_all($delimiter_pattern, $short_description, $delimiter_matches, PREG_OFFSET_CAPTURE)) {
				foreach ($delimiter_matches[0] as $delimiter_match) {
					$match_start = $delimiter_match[1];
					$match_end   = $match_start + strlen($delimiter_match[0]);
					$inside_url  = false;
					foreach ($url_spans as $url_span) {
						if ($match_start >= $url_span[0] && $match_end <= $url_span[1]) {
							$inside_url = true;
							break;
						}
					}
					if (! $inside_url) {
						$has_markup = true;
						break;
					}
				}
			}

			if ($has_markup) {
				$errors[] = 'readme.txt short description must not contain markup.';
			}
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
