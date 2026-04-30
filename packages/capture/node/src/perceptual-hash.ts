import sharp from 'sharp';

/**
 * 64-bit dHash perceptual hash. Compact, fast, robust to small UI changes
 * — exactly what the capture layer needs to skip near-identical screenshots.
 *
 * Algorithm:
 *   - Resize to 9x8 grayscale
 *   - For each row, compare adjacent pixels (8 bits per row * 8 rows = 64)
 */
export async function dHash(image: Buffer): Promise<string> {
  const { data, info } = await sharp(image)
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * width + x] ?? 0;
      const right = data[y * width + x + 1] ?? 0;
      bits += left < right ? '1' : '0';
    }
  }
  // Pack to 16 hex chars.
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Hamming distance between two hex hashes, normalised to 0..1.
 * 0 = identical, 1 = maximally different.
 */
export function hashDiff(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 1;
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = parseInt(a[i] ?? '0', 16);
    const xb = parseInt(b[i] ?? '0', 16);
    let x = xa ^ xb;
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits / (a.length * 4);
}
