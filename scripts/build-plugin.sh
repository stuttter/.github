#!/usr/bin/env bash

set -euo pipefail

repository_path="${1:-.}"
output_directory="${2:-${repository_path}/build}"
manifest_path="${repository_path}/.github/plugin-standard.json"

repository_path="$(cd "${repository_path}" && pwd)"
mkdir -p "${output_directory}"
output_directory="$(cd "${output_directory}" && pwd)"
manifest_path="${repository_path}/.github/plugin-standard.json"

if [[ ! -f "${manifest_path}" ]]; then
	echo "Missing .github/plugin-standard.json." >&2
	exit 1
fi

slug="$(php -r '$m=json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR); echo $m["slug"];' "${manifest_path}")"
version="$(php -r '$m=json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR); $s=file_get_contents($argv[2] . "/" . $m["main_file"]); preg_match("/^[ \\t*#@]*Version:\\s*(.+)$/mi", $s, $v); echo trim($v[1] ?? "");' "${manifest_path}" "${repository_path}")"

if [[ -z "${version}" ]]; then
	echo "Unable to determine plugin version." >&2
	exit 1
fi

archive_path="${output_directory}/${slug}-${version}.zip"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "${temporary_directory}"' EXIT

git -C "${repository_path}" archive --format=tar --prefix="${slug}/" HEAD | tar -xf - -C "${temporary_directory}"

for forbidden_path in .git .github tests node_modules vendor composer.json composer.lock package.json package-lock.json phpunit.xml phpunit.xml.dist phpcs.xml phpcs.xml.dist phpstan.neon phpstan.neon.dist; do
	if [[ -e "${temporary_directory}/${slug}/${forbidden_path}" ]]; then
		echo "Release artifact contains development path: ${forbidden_path}. Add it to .gitattributes export-ignore." >&2
		exit 1
	fi
done

(cd "${temporary_directory}" && zip -X -q -r "${archive_path}" "${slug}")
(cd "${output_directory}" && shasum -a 256 "$(basename "${archive_path}")" > "$(basename "${archive_path}").sha256")
echo "${archive_path}"
