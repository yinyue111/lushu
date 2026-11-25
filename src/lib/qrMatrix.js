/**
 * Zero-dependency ISO/IEC 18004 QR Code matrix generator (Byte mode, EC Level L, Versions 1–8, up to 192 UTF-8 bytes).
 * Loaded lazily only when generating a share poster image — zero impact on the initial bundle.
 */

const VERSION_SPECS_L = [
  null,
  { dataCodewords: 19, ecPerBlock: 7, blocks: 1, align: [] },
  { dataCodewords: 34, ecPerBlock: 10, blocks: 1, align: [6, 18] },
  { dataCodewords: 55, ecPerBlock: 15, blocks: 1, align: [6, 22] },
  { dataCodewords: 80, ecPerBlock: 20, blocks: 1, align: [6, 26] },
  { dataCodewords: 108, ecPerBlock: 26, blocks: 1, align: [6, 30] },
  { dataCodewords: 136, ecPerBlock: 18, blocks: 2, align: [6, 34] },
  { dataCodewords: 156, ecPerBlock: 20, blocks: 2, align: [6, 22, 38] },
  { dataCodewords: 194, ecPerBlock: 24, blocks: 2, align: [6, 24, 42] }
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j += 1) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function formatInfoBits(ecLevelBits, mask) {
  const data = (ecLevelBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionInfoBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function penaltyScore(modules) {
  const n = modules.length;
  let score = 0;
  for (let r = 0; r < n; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < n; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < n; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < n; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }
  return score;
}

/**
 * Encode a UTF-8 string into a square boolean matrix (`true` = dark module).
 * @param {string} text
 * @returns {{ size: number, version: number, modules: boolean[][] }}
 */
export function encodeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let version = 1;
  while (version < VERSION_SPECS_L.length) {
    const spec = VERSION_SPECS_L[version];
    if (spec && bytes.length + 2 <= spec.dataCodewords) break;
    version += 1;
  }
  if (version >= VERSION_SPECS_L.length) {
    throw new Error('二维码链接过长，无法编码');
  }
  const spec = /** @type {NonNullable<typeof VERSION_SPECS_L[number]>} */ (VERSION_SPECS_L[version]);
  const size = version * 4 + 17;

  // Build bit stream: Byte mode (0100) + 8-bit length + payload + terminator + pad codewords
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxDataBits = spec.dataCodewords * 8;
  const term = Math.min(4, maxDataBits - bits.length);
  for (let i = 0; i < term; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < bits.length / 8; i += 1) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i * 8 + b];
    dataBytes[i] = byte;
  }
  let padIdx = 0;
  for (let i = bits.length / 8; i < spec.dataCodewords; i += 1) {
    dataBytes[i] = padIdx % 2 === 0 ? 0xec : 0x11;
    padIdx += 1;
  }

  // Split into blocks and interleave
  const blockDataLen = spec.dataCodewords / spec.blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < spec.blocks; b += 1) {
    const slice = dataBytes.subarray(b * blockDataLen, (b + 1) * blockDataLen);
    dataBlocks.push(slice);
    ecBlocks.push(rsEncode(slice, spec.ecPerBlock));
  }
  const codewords = [];
  for (let i = 0; i < blockDataLen; i += 1) {
    for (let b = 0; b < spec.blocks; b += 1) codewords.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (let b = 0; b < spec.blocks; b += 1) codewords.push(ecBlocks[b][i]);
  }

  // Build base function matrix
  const base = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunc = Array.from({ length: size }, () => Array(size).fill(false));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    base[r][c] = Boolean(dark);
    isFunc[r][c] = true;
  };

  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(top + dr, left + dc, inOuter && (onBorder || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const align = spec.align;
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      const cr = align[i];
      const cc = align[j];
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          setFunctionModule(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve format info & dark module
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      if (!isFunc[8][i]) setFunctionModule(8, i, false);
      if (!isFunc[i][8]) setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(8, size - 1 - i, false);
    if (i < 7) setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true);

  // Version info (V7+)
  if (version >= 7) {
    const vBits = versionInfoBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((vBits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  // Place data bits in upward/downward 2-column zig-zag
  let bitIdx = 0;
  const totalCodewordBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const upward = ((right + 1) & 2) === 0;
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const c = right - j;
        if (isFunc[r][c]) continue;
        let dark = false;
        if (bitIdx < totalCodewordBits) {
          dark = ((codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx += 1;
        }
        base[r][c] = dark;
      }
    }
  }

  const writeFormatBits = (grid, mask) => {
    const fBits = formatInfoBits(0b01, mask); // 0b01 = Level L
    for (let i = 0; i <= 5; i += 1) grid[i][8] = ((fBits >> i) & 1) === 1;
    grid[7][8] = ((fBits >> 6) & 1) === 1;
    grid[8][8] = ((fBits >> 7) & 1) === 1;
    grid[8][7] = ((fBits >> 8) & 1) === 1;
    for (let i = 9; i < 15; i += 1) grid[8][14 - i] = ((fBits >> i) & 1) === 1;

    for (let i = 0; i < 8; i += 1) grid[8][size - 1 - i] = ((fBits >> i) & 1) === 1;
    for (let i = 8; i < 15; i += 1) grid[size - 15 + i][8] = ((fBits >> i) & 1) === 1;
    grid[size - 8][8] = true;
  };

  let bestModules = base;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.map((row, r) => row.map((val, c) => (isFunc[r][c] ? val : val !== maskBit(mask, r, c))));
    writeFormatBits(candidate, mask);
    const score = penaltyScore(candidate);
    if (score < bestPenalty) {
      bestPenalty = score;
      bestModules = candidate;
    }
  }

  return { size, version, modules: bestModules };
}
