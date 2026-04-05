// Preloader: loads ESM babylonjs packages into globalThis so that the
// CJS hammurabi-server files can read them synchronously without require().
import * as BABYLON_CORE      from "@babylonjs/core";
import * as BABYLON_GUI       from "@babylonjs/gui";
import * as BABYLON_MATERIALS from "@babylonjs/materials";
import * as BABYLON_GLTF      from "@babylonjs/loaders";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { dirname, join } from "path";

// Expose to globalThis for patched CJS files
globalThis.__BABYLON_CORE__      = BABYLON_CORE;
globalThis.__BABYLON_GUI__       = BABYLON_GUI;
globalThis.__BABYLON_MATERIALS__ = BABYLON_MATERIALS;
globalThis.__BABYLON_GLTF__      = BABYLON_GLTF;  // needed for GLTFFileLoader instanceof checks

// --- GLTF extension safety guard ---
// KHR_materials_transmission and KHR_materials_volume create WebGL render
// targets that crash Babylon.js NullEngine (no GPU in server context).
// KHR_materials_specular with specularColorFactor > 1.0 produces out-of-range
// PBR values that can NaN-cascade inside material.freeze().
// We disable these here so they silently fall back to base color + alpha mode,
// which preserves ALPHA_MASK / ALPHA_BLEND transparency on the server.
BABYLON_CORE.SceneLoader.OnPluginActivatedObservable.add((plugin) => {
  if (!plugin.onExtensionLoadedObservable) return  // not a GLTF loader
  plugin.onExtensionLoadedObservable.add((ext) => {
    const unsafe = ['KHR_materials_transmission', 'KHR_materials_volume']
    if (unsafe.includes(ext.name)) {
      ext.enabled = false
      console.log('[Hammurabi] Disabled crash-prone GLTF extension:', ext.name)
    }
    if (ext.name === 'KHR_materials_specular') {
      // Clamp specularColorFactor to [0,1] range to avoid NaN in freeze()
      const orig = ext._loadMaterialPropertiesAsync?.bind(ext)
      if (orig) {
        ext._loadMaterialPropertiesAsync = async (context, material, babylonMaterial) => {
          const result = await orig(context, material, babylonMaterial)
          if (babylonMaterial.metallicReflectanceColor) {
            babylonMaterial.metallicReflectanceColor.r = Math.min(1, babylonMaterial.metallicReflectanceColor.r)
            babylonMaterial.metallicReflectanceColor.g = Math.min(1, babylonMaterial.metallicReflectanceColor.g)
            babylonMaterial.metallicReflectanceColor.b = Math.min(1, babylonMaterial.metallicReflectanceColor.b)
          }
          return result
        }
      }
    }
  })
})

// --- CPU watchdog ---
// If the process burns excessive CPU for too long it can freeze the host machine.
// This monitor checks every 3 seconds and force-exits before that can happen.
// Threshold: >80% of one CPU core sustained for 5 consecutive checks (15 seconds).
;(function startCpuWatchdog() {
  const CHECK_MS       = 3_000
  const THRESHOLD_US   = CHECK_MS * 1_000 * 0.80  // 80% of one core in µs
  const MAX_STRIKES    = 5
  let   lastUsage      = process.cpuUsage()
  let   strikes        = 0

  const timer = setInterval(() => {
    const delta  = process.cpuUsage(lastUsage)
    lastUsage    = process.cpuUsage()
    const total  = delta.user + delta.system

    if (total > THRESHOLD_US) {
      strikes++
      console.error(`[Watchdog] High CPU: ${Math.round(total / 1000)}ms in last 3s (strike ${strikes}/${MAX_STRIKES})`)
      if (strikes >= MAX_STRIKES) {
        console.error('[Watchdog] CPU limit exceeded — shutting down to protect system. Restart with npm start.')
        clearInterval(timer)
        process.exit(1)
      }
    } else {
      strikes = 0
    }
  }, CHECK_MS)

  timer.unref()  // don't keep process alive just for this
})()

// --- Guard UniformBuffer *ForEffect methods against undefined _currentEffect ---
// NullEngine never compiles shaders so it never binds an effect to the UniformBuffer.
// Every *ForEffect method (setMatrix, setFloat, setVector3, etc.) unconditionally
// calls this._currentEffect.xxx() — no null guard in Babylon.js 6.4.1 source.
// On any mesh render (opaque OR transparent) this crashes the whole process.
// Fix: wrap every *ForEffect method to no-op when _currentEffect is not set.
// This is safe on NullEngine because nothing is actually rendered anyway.
;(function guardUniformBuffer() {
  const proto = BABYLON_CORE.UniformBuffer?.prototype
  if (!proto) return
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key.endsWith('ForEffect') && typeof proto[key] === 'function') {
      const orig = proto[key]
      proto[key] = function(...args) {
        if (!this._currentEffect) return
        return orig.apply(this, args)
      }
    }
  }
  console.log('[Hammurabi] Patched UniformBuffer: guarded _currentEffect in *ForEffect methods')
})()

// --- Full stack trace on uncaughtException (must register BEFORE cli.js does) ---
// cli.js only logs error.message; this handler also logs the stack so we can
// pinpoint crashes without guessing.
process.prependListener('uncaughtException', (error) => {
  if (error?.stack) console.error('[Hammurabi] Stack:', error.stack)
})
process.prependListener('unhandledRejection', (reason) => {
  if (reason?.stack) console.error('[Hammurabi] Stack:', reason.stack)
})

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require(join(__dirname, "node_modules/@dcl/hammurabi-server/dist/cli.js"));
