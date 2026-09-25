// Generates app icons with zero dependencies (Node built-ins only).
// Run: node scripts/gen-icons.mjs
// Produces: assets/icon.png (256px, color), assets/tray.png + tray@2x.png
// (macOS template images: black shape, alpha knockout).
// Platform installer icons (icon.icns / icon.ico) are NOT generated here —
// see README.md "App icons" for the one-command conversion.

import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'assets')
mkdirSync(outDir, { recursive: true })

// 5x7 bitmap for "R"
const GLYPH = ['01110', '10001', '10001', '11110', '10100', '10010', '10001']

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1)
    raw[off] = 0 // filter: none
    rgba.copy(raw, off + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function roundedMask(x, y, w, h, rad) {
  const cx = Math.min(Math.max(x, rad), w - 1 - rad)
  const cy = Math.min(Math.max(y, rad), h - 1 - rad)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= rad * rad
}

function glyphAt(x, y, w, h, scale) {
  const gw = 5 * scale
  const gh = 7 * scale
  const ox = Math.floor((w - gw) / 2)
  const oy = Math.floor((h - gh) / 2)
  const gx = Math.floor((x - ox) / scale)
  const gy = Math.floor((y - oy) / scale)
  if (gx < 0 || gx > 4 || gy < 0 || gy > 6) return false
  return GLYPH[gy][gx] === '1'
}

function draw({ size, radius, bg, fg, knockout }) {
  const rgba = Buffer.alloc(size * size * 4)
  const scale = Math.max(2, Math.round(size / 11))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!roundedMask(x, y, size, size, radius)) continue // transparent
      const inGlyph = glyphAt(x, y, size, size, scale)
      if (knockout && inGlyph) continue // punch the R out (template image)
      const [rr, gg, bb] = inGlyph ? fg : bg
      rgba[i] = rr
      rgba[i + 1] = gg
      rgba[i + 2] = bb
      rgba[i + 3] = 255
    }
  }
  return encodePng(size, size, rgba)
}

const BLUE = [0x25, 0x63, 0xeb]
const WHITE = [0xff, 0xff, 0xff]
const BLACK = [0x00, 0x00, 0x00]

writeFileSync(
  join(outDir, 'icon.png'),
  draw({ size: 256, radius: 56, bg: BLUE, fg: WHITE, knockout: false })
)
// macOS menu-bar template images (black + alpha; OS tints them)
writeFileSync(
  join(outDir, 'tray.png'),
  draw({ size: 22, radius: 5, bg: BLACK, fg: BLACK, knockout: true })
)
writeFileSync(
  join(outDir, 'tray@2x.png'),
  draw({ size: 44, radius: 10, bg: BLACK, fg: BLACK, knockout: true })
)
console.log('icons written to', outDir)
