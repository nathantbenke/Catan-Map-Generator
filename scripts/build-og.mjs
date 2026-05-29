// Renders public/og.svg → public/og.png at 1200×630. Re-run with
// `npm run build:og` after editing the SVG. The PNG is what the OG/Twitter
// meta tags in index.html point at; SVG OG images are silently broken on
// almost every social platform (Twitter, Facebook, LinkedIn, Discord, etc.)
// so a rendered PNG is what actually shows up in link unfurls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const svgPath = path.join(root, 'public', 'og.svg');
const pngPath = path.join(root, 'public', 'og.png');

const svg = fs.readFileSync(svgPath);
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  font: {
    loadSystemFonts: true,
    // Match the in-app number-token styling so glyphs render the same way
    // here as they do in the live SVG board. Falls back gracefully on
    // systems without Georgia.
    defaultFontFamily: 'Georgia',
  },
});
const pngData = resvg.render().asPng();
fs.writeFileSync(pngPath, pngData);

console.log(`Wrote ${pngPath} (${pngData.length.toLocaleString()} bytes)`);
