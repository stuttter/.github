import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outputRoot = join(root, 'build', 'wp-user-groups');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const expected = [
  ['icon-128x128.png', 128, 128, 1_048_576],
  ['icon-256x256.png', 256, 256, 1_048_576],
  ['banner-solid-772x250.png', 772, 250, 4_194_304],
  ['banner-solid-1544x500.png', 1544, 500, 4_194_304],
  ['banner-sorting-day-772x250.png', 772, 250, 4_194_304],
  ['banner-sorting-day-1544x500.png', 1544, 500, 4_194_304],
];

for (const [filename, width, height, maximumBytes] of expected) {
  const png = await readFile(join(outputRoot, filename));
  if (!png.subarray(0, 8).equals(signature)) {
    throw new Error(`${filename} is not a PNG.`);
  }

  const actualWidth = png.readUInt32BE(16);
  const actualHeight = png.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`${filename} is ${actualWidth}x${actualHeight}; expected ${width}x${height}.`);
  }
  if (png.length > maximumBytes) {
    throw new Error(`${filename} is ${png.length} bytes; limit is ${maximumBytes}.`);
  }
}

console.log('Visual exports have valid dimensions and file sizes.');
