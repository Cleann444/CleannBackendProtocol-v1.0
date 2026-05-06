import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./index.ts', './protocol/predictor.ts', './protocol/delta.ts', './protocol/dns-cache.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outdir: './dist',
  format: 'esm',
  splitting: false,
  packages: 'external'
});
console.log('CBP built');
