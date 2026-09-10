# Plugin visual system

## Direction

The portfolio evolves the original hand-built Dashicons family into a modern
WordPress icon family informed by `@wordpress/icons` and current Gutenberg UI.
It should feel native, restrained, and maintained—not ornamental or generated.

## Construction

- Author every symbol as SVG on a 24 by 24 unit grid.
- Prefer the current WordPress icon vocabulary where an existing symbol matches
  the plugin honestly; draw extensions with the same optical weight.
- Use `currentColor` while constructing marks, then assign approved export
  colors at build time.
- Preserve a clear silhouette and meaningful negative space at 32 pixels.
- Use consistent joins, caps, corner radii, padding, and optical centering.
- Avoid the official WordPress logo and third-party trademarks.

## Family structure

Each plugin receives:

1. One semantic symbol.
2. One accent token selected for contrast and portfolio differentiation.
3. A shared ink and canvas color.
4. A square icon composition with no text.
5. A horizontal banner composition using the same symbol, plugin name, and a
   short human-written descriptor.

The family relationship comes from geometry, typography, spacing, and tone—not
from placing every symbol in an identical colored tile.

## Personality range

The default banner is direct: one strong field color, one mark, one title, and
excellent spacing. Single-color assets are a feature of the existing family and
remain a first-class option.

The system also permits expressive banners when the plugin suggests a specific
visual idea. Those banners may use illustration, pattern, scale, cropping,
humor, or an unexpected composition. They must still use the shared symbol,
palette, typography, and export rules. Personality should come from a concrete
concept tied to the plugin—not generic decoration or visual noise.

Square icons stay restrained and recognizable. Banners get the larger creative
range because they have room to tell a small story without harming recognition
at plugin-list size.

## Avoid

- gradients, glow, glass, faux depth, and drop shadows;
- robots, brains, magic wands, sparkles, and other AI shorthand;
- mascots or jokes that overwhelm the plugin's purpose;
- decorative shapes without a compositional or semantic purpose;
- tiny detail, hairline strokes, or text inside square icons;
- visual similarity that makes adjacent plugins hard to distinguish.

## WordPress.org outputs

Source SVGs generate:

- `icon.svg`;
- `icon-128x128.png`;
- `icon-256x256.png`;
- `banner-772x250.png`;
- `banner-1544x500.png`.

Exports must satisfy the official dimensions and file-size limits. PNG fallbacks
are always included with SVG icons. Asset publication is separate from plugin
code releases because WordPress.org caches the top-level `assets` directory
independently.

## Review

Review the complete family in alphabetical order, by functional group, and at
actual 32, 64, 128, and 256 pixel sizes before replacing any public asset. Check
contrast, silhouette collisions, RTL-safe banner balance, and consistency of
descriptors. Generated explorations are reference material only; production
assets must be reproducible from reviewed source files.
