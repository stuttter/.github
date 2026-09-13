#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
	echo 'Usage: prepare-plugin-build.sh REPOSITORY_PATH OUTPUT_DIRECTORY' >&2
	exit 2
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_path="$(cd "$1" && pwd)"
output_directory="$2"

if [[ -e "${output_directory}" ]]; then
	echo "Output path already exists: ${output_directory}." >&2
	exit 1
fi

manifest_path="${repository_path}/.github/plugin-standard.json"
if [[ ! -f "${manifest_path}" || -L "${manifest_path}" ]]; then
	echo 'Plugin manifest must be a regular file.' >&2
	exit 1
fi

slug="$(php -r '$manifest=json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR); echo $manifest["slug"] ?? "";' "${manifest_path}")"
if [[ ! "${slug}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
	echo 'Plugin manifest contains an invalid slug.' >&2
	exit 1
fi

archive="$(bash "${script_directory}/build-plugin.sh" "${repository_path}" "${output_directory}")"
output_directory="$(cd "${output_directory}" && pwd)"
if [[ ! -f "${archive}" || -L "${archive}" || "$(dirname "${archive}")" != "${output_directory}" ]]; then
	echo 'The deterministic build did not return one regular archive in the output directory.' >&2
	exit 1
fi

extracted_directory="${output_directory}/extracted"
mkdir "${extracted_directory}"
unzip -q "${archive}" -d "${extracted_directory}"

plugin_directory="${extracted_directory}/${slug}"
if [[ ! -d "${plugin_directory}" || -L "${plugin_directory}" ]]; then
	echo "Built plugin directory is missing: ${slug}." >&2
	exit 1
fi
if find "${plugin_directory}" -type l -print -quit | grep -q .; then
	echo 'Built plugin contains a symbolic link.' >&2
	exit 1
fi
if find "${extracted_directory}" -mindepth 1 -maxdepth 1 ! -name "${slug}" -print -quit | grep -q .; then
	echo 'Built archive contains an unexpected top-level path.' >&2
	exit 1
fi

printf '%s\n' "${plugin_directory}"
