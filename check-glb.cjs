#!/usr/bin/env node
// Checks all GLB/GLTF files in the project for properties that crash the
// Babylon.js NullEngine (headless server). Run before deploying:
//   node check-glb.cjs
//
// Crash-causing:
//   KHR_materials_transmission  — requires WebGL render target (no GPU in server)
//   KHR_materials_volume        — same reason
//   specularColorFactor > 1.0   — produces NaN in material.freeze()
//   COLOR_0 accessor type VEC4  — sets hasVertexAlpha=true → transparent sorted
//                                  render pass → _effect undefined on NullEngine → CRASH
//                                  Fix: run patch_vec4_colors.py after each Blender export
//
// Safe for alpha:
//   alphaMode MASK  — leaf/foliage cutout ✅
//   alphaMode BLEND — soft transparency  ✅

const fs   = require('fs')
const path = require('path')

const CRASH_EXTENSIONS = ['KHR_materials_transmission', 'KHR_materials_volume']

function checkGlb(filePath) {
  const data   = fs.readFileSync(filePath)
  const magic  = data.readUInt32LE(0)
  if (magic !== 0x46546C67) return null  // not a GLB

  let offset = 12
  while (offset < data.length) {
    const chunkLen  = data.readUInt32LE(offset)
    const chunkType = data.readUInt32LE(offset + 4)
    if (chunkType === 0x4E4F534A) {  // JSON chunk
      const json = JSON.parse(data.slice(offset + 8, offset + 8 + chunkLen).toString('utf8'))
      const issues = []

      // ── Material checks ─────────────────────────────────────────
      for (const [i, mat] of (json.materials || []).entries()) {
        const exts = mat.extensions || {}
        for (const ext of CRASH_EXTENSIONS) {
          if (exts[ext]) issues.push(`mat[${i}] "${mat.name}": uses ${ext} (CRASH)`)
        }
        const spec = exts.KHR_materials_specular || {}
        const cf   = spec.specularColorFactor || []
        if (cf.some(v => v > 1.0)) {
          issues.push(`mat[${i}] "${mat.name}": specularColorFactor [${cf.join(', ')}] > 1.0 (RISKY — NaN in freeze)`)
        }
      }

      // ── VEC4 COLOR_0 check ───────────────────────────────────────
      // Babylon.js sets hasVertexAlpha=true for VEC4 RGBA vertex colors.
      // This forces the mesh into the transparent sorted render pass which
      // calls _effect.setMatrix() — effect is always null on NullEngine → CRASH.
      // Blender exports vertex colors as VEC4 (RGBA) when the mesh has an
      // alpha channel in its color attribute. Fix: patch_vec4_colors.py strips
      // the alpha byte, converting VEC4 → VEC3.
      for (const [mi, mesh] of (json.meshes || []).entries()) {
        for (const [pi, prim] of (mesh.primitives || []).entries()) {
          const c0idx = (prim.attributes || {}).COLOR_0
          if (c0idx === undefined) continue
          const acc = (json.accessors || [])[c0idx]
          if (acc && acc.type === 'VEC4') {
            issues.push(
              `mesh[${mi}] "${mesh.name}" prim[${pi}]: COLOR_0 is VEC4 (RGBA) — ` +
              `sets hasVertexAlpha=true → NullEngine crash. Run patch_vec4_colors.py to fix.`
            )
          }
        }
      }

      return issues
    }
    offset += 8 + ((chunkLen + 3) & ~3)
  }
  return null
}

function findGlbs(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules') findGlbs(full, results)
    else if (entry.isFile() && entry.name.endsWith('.glb')) results.push(full)
  }
  return results
}

const root  = __dirname
const glbs  = findGlbs(path.join(root, 'assets'))
let   clean = true

console.log(`Checking ${glbs.length} GLB file(s)...\n`)

for (const glb of glbs) {
  const rel    = path.relative(root, glb)
  const issues = checkGlb(glb)
  if (!issues) continue
  if (issues.length === 0) {
    console.log(`  ✅  ${rel}`)
  } else {
    clean = false
    console.log(`  ❌  ${rel}`)
    for (const issue of issues) console.log(`       → ${issue}`)
  }
}

console.log()
if (clean) {
  console.log('All GLBs are server-safe. Safe to deploy.')
} else {
  console.log('Fix the issues above before deploying — they will crash the server.')
  process.exit(1)
}
