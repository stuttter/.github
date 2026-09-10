import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(root, 'sources', 'wp-user-groups');
const outputRoot = join(root, 'build', 'wp-user-groups');

const exports = [
  ['icon.svg', 128, 'icon-128x128.png'],
  ['icon.svg', 256, 'icon-256x256.png'],
  ['banner-solid.svg', 772, 'banner-solid-772x250.png'],
  ['banner-solid.svg', 1544, 'banner-solid-1544x500.png'],
  ['banner-sorting-day.svg', 772, 'banner-sorting-day-772x250.png'],
  ['banner-sorting-day.svg', 1544, 'banner-sorting-day-1544x500.png'],
];

await mkdir(outputRoot, { recursive: true });

for (const [sourceName, width, outputName] of exports) {
  const source = await readFile(join(sourceRoot, sourceName), 'utf8');
  const renderer = new Resvg(source, {
    fitTo: { mode: 'width', value: width },
    shapeRendering: 2,
    textRendering: 2,
    imageRendering: 0,
  });
  const png = renderer.render().asPng();
  await writeFile(join(outputRoot, outputName), png);
  console.log(`${outputName}: ${png.length} bytes`);
}
