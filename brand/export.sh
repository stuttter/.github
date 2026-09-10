#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_root="${root}/sources/wp-user-groups"
output_root="${root}/build/wp-user-groups"

mkdir -p "${output_root}"

magick -density 384 -background none "${source_root}/icon.svg" -resize 128x128 "${output_root}/icon-128x128.png"
magick -density 384 -background none "${source_root}/icon.svg" -resize 256x256 "${output_root}/icon-256x256.png"
magick -density 192 -background none "${source_root}/banner-solid.svg" -resize 772x250! "${output_root}/banner-solid-772x250.png"
magick -density 192 -background none "${source_root}/banner-solid.svg" -resize 1544x500! "${output_root}/banner-solid-1544x500.png"
magick -density 192 -background none "${source_root}/banner-sorting-day.svg" -resize 772x250! "${output_root}/banner-sorting-day-772x250.png"
magick -density 192 -background none "${source_root}/banner-sorting-day.svg" -resize 1544x500! "${output_root}/banner-sorting-day-1544x500.png"

for output in "${output_root}"/*.png; do
  identify "${output}"
done
