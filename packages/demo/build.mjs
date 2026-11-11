// Builds two outputs from src/page.html + src/main.ts:
//   dist/index.html    - standalone page for any static host (Cloudflare Pages, etc.)
//   dist/fragment.html - the same page without the document wrapper (for embedding hosts)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const cdn = [
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>',
  '<script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js"></script>',
].join('\n');

const fragment = readFileSync('src/page.html', 'utf8').replace('<!--CDN-->', cdn).replace('<!--APP-->', `<script>${js}</script>`);
const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${fragment}
</body>
</html>
`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/fragment.html', fragment);
writeFileSync('dist/index.html', standalone);
console.log(`dist/index.html ${(standalone.length / 1024).toFixed(0)} KB (app script ${(js.length / 1024).toFixed(0)} KB)`);
