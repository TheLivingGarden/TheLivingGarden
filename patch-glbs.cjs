#!/usr/bin/env node
// =============================================================
// patch-glbs.cjs — manual rescue tool only (2026-09-28: pulled out of
// prestart/predeploy — see below)
// =============================================================
// Converts VEC4 COLOR_0 vertex-color accessors → VEC3 in all scene GLBs.
//
// WHY IT EXISTED: Babylon.js sets hasVertexAlpha=true when a mesh's COLOR_0
// attribute is RGBA (VEC4). This forces the mesh into the transparent sorted
// render pass, which calls effect.setMatrix() on every frame. On an OLD
// PINNED hammurabi-server, the NullEngine never compiled shaders so effect
// was undefined → crash → room.onReady() never fired on clients.
//
// WHY IT NO LONGER RUNS AUTOMATICALLY: check-glb.cjs's header (2026-09-18,
// measured against the current stock hammurabi-server 1.7.2) found this class
// of render-pass problem now only skips a frame — the server's render loop is
// wrapped in try/catch, and skipping a frame on a HEADLESS server that renders
// to no one is a non-issue. The crash this script exists to prevent was
// already fixed upstream. Meanwhile it ran on every `npm start`, over ALL
// scene GLBs (not just the ones the server loads — see check-glb.cjs's
// serverGlbs() scoping), rewriting tracked source art in place with no
// backup, into VEC3 data that isn't itself 4-byte aligned (no byteStride
// set) — spec-invalid glTF. check-glb.cjs still runs at predeploy and will
// keep flagging this class of issue, now correctly as a warning, not a
// blocker.
//
// Blender always exports vertex colors as VEC4 (RGBA) when the mesh has
// an alpha channel in its colour attribute. Until the Blender file is fixed
// to use RGB-only vertex colours, this patch strips the alpha byte after
// every export.
//
// Run manually if a check-glb.cjs warning turns out to matter again:
//   npm run patch-glbs
// =============================================================

const fs   = require('fs')
const path = require('path')

const ASSETS_DIR = path.join(__dirname, 'assets')

// ── GLB helpers ──────────────────────────────────────────────────────────────

function readGlb(filePath) {
  const raw = fs.readFileSync(filePath)
  const magic = raw.readUInt32LE(0)
  if (magic !== 0x46546C67) return null  // not a GLB

  let jsonData = null, binData = null
  let jsonChunkOffset = -1, binChunkOffset = -1

  let offset = 12
  while (offset < raw.length) {
    const chunkLen  = raw.readUInt32LE(offset)
    const chunkType = raw.readUInt32LE(offset + 4)
    if (chunkType === 0x4E4F534A) {  // JSON
      jsonChunkOffset = offset
      jsonData = JSON.parse(raw.slice(offset + 8, offset + 8 + chunkLen).toString('utf8'))
    } else if (chunkType === 0x004E4942) {  // BIN
      binChunkOffset = offset
      binData = raw.slice(offset + 8, offset + 8 + chunkLen)
    }
    offset += 8 + ((chunkLen + 3) & ~3)
  }

  return { raw, jsonData, binData, jsonChunkOffset, binChunkOffset }
}

function patchVec4Colors(filePath) {
  const glb = readGlb(filePath)
  if (!glb || !glb.jsonData || !glb.binData) return 0

  const { jsonData: gltf, binData } = glb
  const accessors    = gltf.accessors    || []
  const bufferViews  = gltf.bufferViews  || []
  const meshes       = gltf.meshes       || []

  // Collect all accessor indices used as VEC4 COLOR_N (any vertex colour set)
  // Babylon.js sets hasVertexAlpha=true for *any* COLOR_N accessor that is VEC4,
  // not just COLOR_0.  Secondary colour sets (COLOR_1, COLOR_2 …) exported by
  // Blender as RGBA are equally crash-causing on NullEngine.
  const vec4Indices = new Set()
  for (const mesh of meshes) {
    for (const prim of (mesh.primitives || [])) {
      for (const [attr, idx] of Object.entries(prim.attributes || {})) {
        if (/^COLOR_\d+$/.test(attr) && accessors[idx] && accessors[idx].type === 'VEC4') {
          vec4Indices.add(idx)
        }
      }
    }
  }

  if (vec4Indices.size === 0) return 0  // nothing to do

  const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5126: 4 }

  // New BIN = existing bin + stripped RGB data for each patched accessor
  const newBinParts = [binData]

  for (const accIdx of [...vec4Indices].sort((a, b) => a - b)) {
    const acc      = accessors[accIdx]
    const bv       = bufferViews[acc.bufferView]
    const count    = acc.count
    const compSize = COMPONENT_BYTES[acc.componentType] || 1
    const stride   = bv.byteStride || (4 * compSize)   // VEC4 stride
    const bvOff    = bv.byteOffset || 0
    const accOff   = acc.byteOffset || 0

    // Extract RGB, drop A
    const rgbBuf = Buffer.allocUnsafe(count * 3 * compSize)
    for (let i = 0; i < count; i++) {
      const src = bvOff + accOff + i * stride
      binData.copy(rgbBuf, i * 3 * compSize, src, src + 3 * compSize)
    }

    // Pad to 4-byte boundary
    const pad     = (4 - (rgbBuf.length % 4)) % 4
    const padded  = pad ? Buffer.concat([rgbBuf, Buffer.alloc(pad)]) : rgbBuf

    const newBvOffset  = newBinParts.reduce((s, b) => s + b.length, 0)
    const newBvByteLen = count * 3 * compSize

    // Append new buffer view
    const newBvIdx = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: newBvOffset, byteLength: newBvByteLen })
    newBinParts.push(padded)

    // Update accessor in-place: VEC4 → VEC3, point to new buffer view
    acc.type        = 'VEC3'
    acc.bufferView  = newBvIdx
    acc.byteOffset  = 0
    delete acc.byteStride
  }

  // Rebuild BIN
  const newBin       = Buffer.concat(newBinParts)
  const newBinPadLen = (4 - (newBin.length % 4)) % 4
  const newBinPadded = newBinPadLen ? Buffer.concat([newBin, Buffer.alloc(newBinPadLen)]) : newBin

  gltf.buffers[0].byteLength = newBinPadded.length

  // Rebuild JSON
  const jsonStr    = JSON.stringify(gltf, null, 0)
  const jsonBuf    = Buffer.from(jsonStr, 'utf8')
  const jsonPadLen = (4 - (jsonBuf.length % 4)) % 4
  const jsonPadded = jsonPadLen ? Buffer.concat([jsonBuf, Buffer.alloc(jsonPadLen, 0x20)]) : jsonBuf

  // Assemble GLB
  const jsonChunkTotal = 8 + jsonPadded.length
  const binChunkTotal  = 8 + newBinPadded.length
  const totalLen       = 12 + jsonChunkTotal + binChunkTotal

  const header = Buffer.allocUnsafe(12)
  header.writeUInt32LE(0x46546C67, 0)  // magic
  header.writeUInt32LE(2, 4)           // version
  header.writeUInt32LE(totalLen, 8)

  const jsonHeader = Buffer.allocUnsafe(8)
  jsonHeader.writeUInt32LE(jsonPadded.length, 0)
  jsonHeader.writeUInt32LE(0x4E4F534A, 4)

  const binHeader = Buffer.allocUnsafe(8)
  binHeader.writeUInt32LE(newBinPadded.length, 0)
  binHeader.writeUInt32LE(0x004E4942, 4)

  const out = Buffer.concat([header, jsonHeader, jsonPadded, binHeader, newBinPadded])
  fs.writeFileSync(filePath, out)

  return vec4Indices.size
}

// ── Clamp out-of-spec specularColorFactor ────────────────────────────────────
//
// WHY: KHR_materials_specular.specularColorFactor is defined [0,1] per channel. A value
// above 1.0 (Blender lets you type any number into "Specular Tint") produces a NaN in the
// explorer's material.freeze() step — check-glb.cjs blocks deploy on this (see its
// CRASH_EXTENSIONS / specularColorFactor check). This is the automatic fix: clamp each
// channel to 1.0, the closest valid value, the same "sanitize before deploy" role
// patchVec4Colors already plays for its own crash class.

function clampSpecularColorFactor(filePath) {
  const glb = readGlb(filePath)
  if (!glb || !glb.jsonData) return 0

  const gltf = glb.jsonData
  let patched = 0

  for (const mat of (gltf.materials || [])) {
    const spec = mat.extensions && mat.extensions.KHR_materials_specular
    const cf   = spec && spec.specularColorFactor
    if (!Array.isArray(cf) || !cf.some(v => v > 1.0)) continue
    spec.specularColorFactor = cf.map(v => Math.min(1.0, v))
    patched++
  }

  if (patched === 0) return 0

  // JSON-only rebuild (BIN chunk untouched).
  const jsonStr    = JSON.stringify(gltf, null, 0)
  const jsonBuf    = Buffer.from(jsonStr, 'utf8')
  const jsonPadLen = (4 - (jsonBuf.length % 4)) % 4
  const jsonPadded = jsonPadLen ? Buffer.concat([jsonBuf, Buffer.alloc(jsonPadLen, 0x20)]) : jsonBuf

  const binPadded = glb.binData
    ? (() => {
        const pad = (4 - (glb.binData.length % 4)) % 4
        return pad ? Buffer.concat([glb.binData, Buffer.alloc(pad)]) : glb.binData
      })()
    : null

  const jsonChunkTotal = 8 + jsonPadded.length
  const binChunkTotal  = binPadded ? 8 + binPadded.length : 0
  const totalLen       = 12 + jsonChunkTotal + binChunkTotal

  const header = Buffer.allocUnsafe(12)
  header.writeUInt32LE(0x46546C67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(totalLen, 8)

  const jsonHeader = Buffer.allocUnsafe(8)
  jsonHeader.writeUInt32LE(jsonPadded.length, 0)
  jsonHeader.writeUInt32LE(0x4E4F534A, 4)

  const parts = [header, jsonHeader, jsonPadded]

  if (binPadded) {
    const binHeader = Buffer.allocUnsafe(8)
    binHeader.writeUInt32LE(binPadded.length, 0)
    binHeader.writeUInt32LE(0x004E4942, 4)
    parts.push(binHeader, binPadded)
  }

  fs.writeFileSync(filePath, Buffer.concat(parts))
  return patched
}

// ── _collider meshes are NOT stripped (removed 2026-09-27) ───────────────────
//
// This script used to delete every mesh whose MESH name ended in '_collider', on the
// theory that production hammurabi crashes on them (setColliderMask → opacity-0
// GridMaterial → transparent pass → NullEngine setMatrix crash). Removed because:
//   • it deleted KJ's Blender colliders from the exported GLB on every `npm run start`
//     (StandBottom/StandTop/SolarPanel_collider were lost this way) — colliders are
//     needed for player AND native camera collision;
//   • locally it did nothing useful: hammurabi.mjs already guards that crash;
//   • hammurabi matches the Babylon mesh name, which the glTF loader takes from the
//     NODE name — so node-named colliders (Blender's usual export) passed straight
//     through the mesh-name check anyway;
//   • Clean The Club runs in production with 33 '_collider' nodes in mainstructure.glb
//     and no stripping. If a Bloom Garden deploy ever hangs at room.onReady(), check
//     this first — but never fix it by deleting colliders from the source asset.

// ── Main ─────────────────────────────────────────────────────────────────────

function findGlbs(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules') findGlbs(full, results)
    else if (entry.isFile() && entry.name.endsWith('.glb')) results.push(full)
  }
  return results
}

const glbs = findGlbs(ASSETS_DIR)
let totalVec4    = 0
let filesVec4    = 0
let totalSpecular = 0
let filesSpecular = 0

console.log(`[patch-glbs] Scanning ${glbs.length} GLB(s) for VEC4 vertex colors and out-of-spec specular...`)

for (const glb of glbs) {
  const rel = path.relative(__dirname, glb)

  const vec4Count = patchVec4Colors(glb)
  if (vec4Count > 0) {
    console.log(`[patch-glbs] ✅ VEC4→VEC3: ${vec4Count} accessor(s) in ${rel}`)
    totalVec4 += vec4Count
    filesVec4++
  }

  const specCount = clampSpecularColorFactor(glb)
  if (specCount > 0) {
    console.log(`[patch-glbs] ✅ Clamped specularColorFactor: ${specCount} material(s) in ${rel}`)
    totalSpecular += specCount
    filesSpecular++
  }
}

if (filesVec4 === 0 && filesSpecular === 0) {
  console.log('[patch-glbs] All GLBs already clean — nothing to patch.')
} else {
  if (filesVec4     > 0) console.log(`[patch-glbs] VEC4 done:     ${totalVec4} accessor(s) across ${filesVec4} file(s).`)
  if (filesSpecular > 0) console.log(`[patch-glbs] Specular done: ${totalSpecular} material(s) clamped across ${filesSpecular} file(s).`)
}
