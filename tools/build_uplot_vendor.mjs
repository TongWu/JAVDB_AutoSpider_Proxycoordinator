/**
 * tools/build_uplot_vendor.mjs
 *
 * Reads pre-downloaded uPlot dist files from /tmp/uplot-vendor/ and writes
 * src/uplot_vendor.ts with the JS and CSS embedded as template-literal string
 * constants.
 *
 * Usage:
 *   node tools/build_uplot_vendor.mjs
 *
 * Expects:
 *   /tmp/uplot-vendor/uplot.min.js   — uPlot.iife.min.js from cdn.jsdelivr.net
 *   /tmp/uplot-vendor/uplot.min.css  — uPlot.min.css from cdn.jsdelivr.net
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const js = readFileSync('/tmp/uplot-vendor/uplot.min.js', 'utf8');
const css = readFileSync('/tmp/uplot-vendor/uplot.min.css', 'utf8');

// Escape the three template-literal control characters so the content can be
// safely embedded inside backtick strings without terminating them or causing
// unintended interpolations.
function escForTemplateLiteral(s) {
  return s
    .replaceAll('\\', '\\\\')   // backslash first (must come before the others)
    .replaceAll('`', '\\`')     // backtick
    .replaceAll('${', '\\${');  // dollar-brace
}

const escapedJs = escForTemplateLiteral(js);
const escapedCss = escForTemplateLiteral(css);

const out = `/**
 * Phase 3 — vendored uPlot v1.6.31 (MIT licensed, see https://github.com/leeoniya/uPlot).
 *
 * Inlined into the Worker so the dashboard ships with zero external
 * runtime dependencies (CSP-friendly, no CDN trust). Bundle cost: ~14KB
 * gzip — negligible compared to the dashboard HTML itself.
 */
export const UPLOT_MIN_JS = \`${escapedJs}\`;
export const UPLOT_MIN_CSS = \`${escapedCss}\`;
`;

const outPath = join(repoRoot, 'src', 'uplot_vendor.ts');
writeFileSync(outPath, out, 'utf8');
console.log(`Wrote ${outPath}`);
console.log(`  JS length  : ${js.length} chars (raw)`);
console.log(`  CSS length : ${css.length} chars (raw)`);
