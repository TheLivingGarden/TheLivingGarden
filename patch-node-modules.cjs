#!/usr/bin/env node
// Patches node_modules after npm install.
// Re-run automatically via the "postinstall" script in package.json.
//
// Patches applied:
//   1. @dcl/hammurabi-server — replace all require("@babylonjs/*") with
//      globalThis.__BABYLON_*__ so ESM babylon can be preloaded via hammurabi.mjs
//   2. @dcl/sdk-commands     — replace npx spawn with local hammurabi.mjs spawn
//      so the preloader is always used when running `npm start`
//   3. @dcl/sdk/server       — create the Storage module shim so the bundler can
//      resolve it (the production DCL server runtime provides the real one)

const fs   = require('fs')
const path = require('path')

const root = __dirname

// ── 1. Patch hammurabi-server dist files ─────────────────────────────────────

const hamDir = path.join(root, 'node_modules/@dcl/hammurabi-server/dist')

const replacements = [
  [/require\(["']@babylonjs\/core["']\)/g,      'globalThis.__BABYLON_CORE__'],
  [/require\(["']@babylonjs\/gui["']\)/g,       'globalThis.__BABYLON_GUI__'],
  [/require\(["']@babylonjs\/materials["']\)/g, 'globalThis.__BABYLON_MATERIALS__'],
  // Must be the full module (not {}), GLTFFileLoader instanceof checks depend on it
  [/require\(["']@babylonjs\/loaders.*?["']\)/g,'globalThis.__BABYLON_GLTF__'],
]

function patchDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { patchDir(full); continue }
    if (!entry.name.endsWith('.js')) continue
    let src = fs.readFileSync(full, 'utf8')
    let changed = false
    for (const [pattern, replacement] of replacements) {
      const next = src.replace(pattern, replacement)
      if (next !== src) { src = next; changed = true }
    }
    if (changed) {
      fs.writeFileSync(full, src)
      console.log('  patched:', path.relative(root, full))
    }
  }
}

if (fs.existsSync(hamDir)) {
  console.log('[postinstall] Patching @dcl/hammurabi-server ...')
  patchDir(hamDir)

  // ── 1b. Patch colliders.js — fix NullEngine transparent-pass crash ──────────
  // colliders.js creates a GridMaterial with opacity=0 for all _collider meshes.
  // In Babylon.js, opacity<1 sets needAlphaBlending()=true which puts the mesh
  // into the transparent sorted render pass.  NullEngine never compiles shaders
  // so the material effect is always undefined → setMatrix() crash every frame.
  //
  // Fix: remove the opacity=0 line — disableColorWrite=true (already set below it)
  // achieves the same visual result (invisible mesh) without triggering the
  // transparent render path.
  const collidersFile = path.join(hamDir, 'lib/babylon/scene/logic/colliders.js')
  if (fs.existsSync(collidersFile)) {
    let src = fs.readFileSync(collidersFile, 'utf8')
    // Match exactly the opacity=0 assignment inside colliderMaterial
    if (src.includes('m.opacity = 0;')) {
      src = src.replace('m.opacity = 0;', '// m.opacity = 0; // patched: keep opaque so mesh stays out of transparent render pass (NullEngine crash fix)')
      fs.writeFileSync(collidersFile, src)
      console.log('  patched: colliders.js — removed opacity=0 to prevent NullEngine transparent-pass crash')
    } else {
      console.log('  colliders.js — opacity=0 line not found (already patched or changed)')
    }
  } else {
    console.warn('  colliders.js not found — skipping collider opacity patch')
  }

  // Wrap render loop in try/catch so NullEngine _effect=null crash is swallowed.
  // NullEngine never compiles shaders so _effect is always null, but the render
  // loop still runs (activeCamera is set). _RenderSorted has no isReady() guard
  // so it crashes on every opaque mesh render → setMatrix on null effect.
  const babylonIndexFile = path.join(hamDir, 'lib/babylon/index.js')
  if (fs.existsSync(babylonIndexFile)) {
    let src = fs.readFileSync(babylonIndexFile, 'utf8')
    if (src.includes('scene.render();') && !src.includes('try {')) {
      src = src.replace(
        'function renderLoop() {\n        if (scene.activeCamera) {\n            scene.render();\n        }\n    }',
        'function renderLoop() {\n        if (scene.activeCamera) {\n            try {\n                scene.render();\n            } catch (_) {\n                // NullEngine: _effect null, swallow setMatrix crash\n            }\n        }\n    }'
      )
      fs.writeFileSync(babylonIndexFile, src)
      console.log('  patched: babylon/index.js — wrapped render loop in try/catch')
    } else {
      console.log('  babylon/index.js — render loop already patched or changed')
    }
  }

  console.log('[postinstall] hammurabi-server patch done.')
} else {
  console.warn('[postinstall] @dcl/hammurabi-server not found — skipping.')
}

// ── 2. Patch sdk-commands hammurabi-server.js ─────────────────────────────────

const sdkCmdFile = path.join(
  root,
  'node_modules/@dcl/sdk-commands/dist/commands/start/hammurabi-server.js'
)

if (fs.existsSync(sdkCmdFile)) {
  console.log('[postinstall] Patching @dcl/sdk-commands ...')
  let src = fs.readFileSync(sdkCmdFile, 'utf8')

  // Only patch if still in original npx form
  if (src.includes("'--yes'") && !src.includes('hammurabi.mjs')) {
    // Add path require if missing
    if (!src.includes("require(\"path\")") && !src.includes("require('path')")) {
      src = src.replace(
        "const child_process_1 = require(\"child_process\");",
        "const child_process_1 = require(\"child_process\");\nconst path_1 = require(\"path\");"
      )
    }

    // Replace npx spawn block with local hammurabi.mjs spawn
    src = src.replace(
      /const npxArgs = \[.*?\];[\s\S]*?const hammurabiProcess = npxCliJs[\s\S]*?\);/,
      `const env = (0, utils_1.isElectronEnvironment)() ? { ...(0, utils_1.getSpawnEnv)(), npm_config_prefix: workingDir } : (0, utils_1.getSpawnEnv)();
    const preloaderPath = (0, path_1.join)(workingDir, 'hammurabi.mjs');
    const hammurabiProcess = (0, child_process_1.spawn)(process.execPath, [preloaderPath, \`--realm=\${realm}\`, '--production'], { cwd: workingDir, shell: false, stdio: 'inherit', env });`
    )

    fs.writeFileSync(sdkCmdFile, src)
    console.log('[postinstall] sdk-commands patch done.')
  } else {
    console.log('[postinstall] sdk-commands already patched — skipping.')
  }
} else {
  console.warn('[postinstall] @dcl/sdk-commands hammurabi-server.js not found — skipping.')
}

// ── 3. Create @dcl/sdk/server — Storage shim ─────────────────────────────────
// @dcl/sdk/server is not shipped with the installed SDK version; the production
// DCL server runtime injects the real implementation.  For local dev we create a
// file-backed shim so the bundler can resolve the import and the server can run.
//
// Data files written by the shim:
//   server-storage.json         — global key→value store  (scene-wide persistence)
//   server-storage-players.json — address→{key→value}     (per-player persistence)

const sdkServerJs = path.join(root, 'node_modules/@dcl/sdk/server.js')
const sdkServerDts = path.join(root, 'node_modules/@dcl/sdk/server.d.ts')

const serverJsContent = `'use strict'
// @dcl/sdk/server — file-backed Storage shim for local / hammurabi-server dev.
// The production DCL server runtime replaces this with its own implementation.
//
// fs and path are loaded via Function() so esbuild cannot statically resolve them
// when bundling the client — they are Node.js built-ins used only server-side.
const _r   = Function('return require')()
const fs   = _r('fs')
const path = _r('path')

const GLOBAL_FILE = path.join(process.cwd(), 'server-storage.json')
const PLAYER_FILE  = path.join(process.cwd(), 'server-storage-players.json')

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)) } catch (e) {
    console.error('[Storage] write failed:', e.message)
  }
}

const Storage = {
  async get(key) {
    return readJSON(GLOBAL_FILE)[key] ?? null
  },
  async set(key, value) {
    const data = readJSON(GLOBAL_FILE)
    data[key] = value
    writeJSON(GLOBAL_FILE, data)
  },
  player: {
    async get(address, key) {
      return (readJSON(PLAYER_FILE)[address] ?? {})[key] ?? null
    },
    async set(address, key, value) {
      const data = readJSON(PLAYER_FILE)
      if (!data[address]) data[address] = {}
      data[address][key] = value
      writeJSON(PLAYER_FILE, data)
    },
  },
}

module.exports = { Storage }
`

const serverDtsContent = `// @dcl/sdk/server — type declarations for the Storage persistence API.
export declare const Storage: {
  get<T = string>(key: string): Promise<T | null>
  set(key: string, value: string): Promise<void>
  player: {
    get<T = string>(address: string, key: string): Promise<T | null>
    set(address: string, key: string, value: string): Promise<void>
  }
}
`

const sdkDir = path.join(root, 'node_modules/@dcl/sdk')
if (fs.existsSync(sdkDir)) {
  fs.writeFileSync(sdkServerJs,  serverJsContent)
  fs.writeFileSync(sdkServerDts, serverDtsContent)
  console.log('[postinstall] @dcl/sdk/server shim created.')
} else {
  console.warn('[postinstall] @dcl/sdk not found — skipping server shim.')
}
