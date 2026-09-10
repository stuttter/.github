#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_root="${root}/build/wp-user-groups"

expected=(
  'icon-128x128.png:128x128:1048576'
  'icon-256x256.png:256x256:1048576'
  'banner-solid-772x250.png:772x250:4194304'
  'banner-solid-1544x500.png:1544x500:4194304'
  'banner-sorting-day-772x250.png:772x250:4194304'
  'banner-sorting-day-1544x500.png:1544x500:4194304'
)

for specification in "${expected[@]}"; do
  IFS=: read -r filename dimensions maximum_bytes <<< "${specification}"
  path="${output_root}/${filename}"
  test -f "${path}"

  actual_dimensions="$(identify -format '%wx%h' "${path}")"
  if [[ "${actual_dimensions}" != "${dimensions}" ]]; then
    echo "${filename} is ${actual_dimensions}; expected ${dimensions}." >&2
    exit 1
  fi

  actual_bytes="$(wc -c < "${path}" | tr -d ' ')"
  if (( actual_bytes > maximum_bytes )); then
    echo "${filename} is ${actual_bytes} bytes; limit is ${maximum_bytes}." >&2
    exit 1
  fi
done

echo 'Visual exports have valid dimensions and file sizes.'
