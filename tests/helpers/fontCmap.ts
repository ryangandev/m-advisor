import { readFileSync } from "node:fs";

/** The code points a TrueType or OpenType font file has glyphs for, read from its Unicode `cmap` (format 4 and 12). */
export function fontCodePoints(file: string): Set<number> {
  const data = readFileSync(file);
  const tableCount = data.readUInt16BE(4);
  let cmapOffset = -1;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (data.toString("ascii", record, record + 4) === "cmap") cmapOffset = data.readUInt32BE(record + 8);
  }
  if (cmapOffset < 0) throw new Error(`${file} has no cmap table`);

  const points = new Set<number>();
  const subtableCount = data.readUInt16BE(cmapOffset + 2);
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmapOffset + 4 + index * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    // Unicode (0) or Windows Unicode BMP (3, 1) and full repertoire (3, 10).
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const start = cmapOffset + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(start);
    if (format === 4) {
      const segments = data.readUInt16BE(start + 6) / 2;
      const endCodes = start + 14;
      const startCodes = endCodes + segments * 2 + 2;
      const idDeltas = startCodes + segments * 2;
      const idRangeOffsets = idDeltas + segments * 2;
      for (let segment = 0; segment < segments; segment += 1) {
        const end = data.readUInt16BE(endCodes + segment * 2);
        const first = data.readUInt16BE(startCodes + segment * 2);
        const delta = data.readInt16BE(idDeltas + segment * 2);
        const rangeOffset = data.readUInt16BE(idRangeOffsets + segment * 2);
        for (let code = first; code <= end && code !== 0xffff; code += 1) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            const location = idRangeOffsets + segment * 2 + rangeOffset + (code - first) * 2;
            glyph = data.readUInt16BE(location);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) points.add(code);
        }
      }
    } else if (format === 12) {
      const groups = data.readUInt32BE(start + 12);
      for (let group = 0; group < groups; group += 1) {
        const at = start + 16 + group * 12;
        const first = data.readUInt32BE(at);
        const last = data.readUInt32BE(at + 4);
        const glyph = data.readUInt32BE(at + 8);
        for (let code = first; code <= last; code += 1) if (glyph + (code - first) !== 0) points.add(code);
      }
    }
  }
  return points;
}
