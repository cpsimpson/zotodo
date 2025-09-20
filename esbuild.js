const path = require('path')
const rmrf = require('rimraf')
const fs = require('fs')
const esbuild = require('esbuild')

require('zotero-plugin/copy-assets')
require('zotero-plugin/rdf')
require('zotero-plugin/version')

async function build() {
  rmrf.sync('gen')
  await esbuild.build({
    bundle: true,
    format: 'iife',
    globalName: 'ZotodoBundle',
    target: ['firefox60'],
    entryPoints: [ 'content/zotodo.ts', 'content/options.ts' ],
    outdir: 'build/content',
  })

  // Ensure a Zotero 7/8 compatible WebExtension manifest is present in build/
  // Use the source manifest.json (already updated) rather than the generator's Zotero 7-only manifest
  fs.copyFileSync(path.join(__dirname, 'manifest.json'), path.join(__dirname, 'build/manifest.json'))

  // Ensure bootstrap.js is included at the XPI root (build/)
  fs.copyFileSync(path.join(__dirname, 'bootstrap.js'), path.join(__dirname, 'build/bootstrap.js'))
}

build().catch(err => {
  console.log(err)
  process.exit(1)
})
