#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 4 ]]; then
	echo 'Usage: run-wordpress-integration.sh WP_ENV CONFIG SLUG TOPOLOGY' >&2
	exit 2
fi

wp_env="$1"
config="$2"
slug="$3"
topology="$4"

if [[ ! -x "${wp_env}" || ! -f "${config}" || -L "${config}" ]]; then
	echo 'WordPress integration runtime or configuration is invalid.' >&2
	exit 2
fi
if [[ ! "${slug}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
	echo 'WordPress integration slug is invalid.' >&2
	exit 2
fi
if [[ "${topology}" != 'single-site' && "${topology}" != 'multisite' ]]; then
	echo 'WordPress integration topology is invalid.' >&2
	exit 2
fi

started='false'
cleanup() {
	status=$?
	trap - EXIT
	if [[ "${started}" == 'true' ]]; then
		"${wp_env}" destroy --force --config="${config}" || true
	fi
	exit "${status}"
}
trap cleanup EXIT

started='true'
"${wp_env}" start --update --config="${config}"
"${wp_env}" run cli --config="${config}" wp core version

if [[ "${topology}" == 'multisite' ]]; then
	"${wp_env}" run cli --config="${config}" wp plugin activate "${slug}" --network
	"${wp_env}" run cli --config="${config}" wp plugin is-active "${slug}" --network
	"${wp_env}" run cli --config="${config}" wp eval 'if ( ! is_multisite() ) { throw new RuntimeException( "Expected multisite." ); }'
else
	"${wp_env}" run cli --config="${config}" wp plugin activate "${slug}"
	"${wp_env}" run cli --config="${config}" wp plugin is-active "${slug}"
	"${wp_env}" run cli --config="${config}" wp eval 'if ( is_multisite() ) { throw new RuntimeException( "Expected single-site." ); }'
fi

"${wp_env}" run cli --config="${config}" wp eval-file wp-content/portfolio-integration-tests/smoke.php
