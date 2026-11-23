// Bundle the example page: `yarn build` here (after the packages are built), then serve this folder
// with any static server on https or localhost, since wallets inject only into secure pages.
import { build } from 'esbuild'

await build({
  entryPoints: [new URL('./main.ts', import.meta.url).pathname],
  outfile: new URL('./dist/main.js', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
})
