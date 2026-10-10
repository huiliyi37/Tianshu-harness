/** Read the actual encoded dimensions; never guess an aspect ratio. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    width = view.getUint32(16); height = view.getUint32(20)
  } else if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49) {
    width = view.getUint16(6, true); height = view.getUint16(8, true)
  } else if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(12, 16)) === 'VP8X') {
    width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
    height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]!, length = view.getUint16(offset + 2)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break
      }
      if (length < 2) break
      offset += length + 2
    }
  }
  return width > 0 && height > 0 ? { width, height } : undefined
}
