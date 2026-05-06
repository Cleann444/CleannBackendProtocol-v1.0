// Binary diff using simple XOR for demonstration (replace with bsdiff for production)
export class DeltaCalculator {
  computeDelta(oldBuf: Buffer, newBuf: Buffer): Buffer {
    if (oldBuf.length !== newBuf.length) return newBuf;
    const diff = Buffer.alloc(oldBuf.length);
    for (let i = 0; i < oldBuf.length; i++) {
      diff[i] = oldBuf[i] ^ newBuf[i];
    }
    return diff;
  }
  
  applyPatch(oldBuf: Buffer, patchBuf: Buffer): Buffer {
    const result = Buffer.alloc(oldBuf.length);
    for (let i = 0; i < oldBuf.length; i++) {
      result[i] = oldBuf[i] ^ patchBuf[i];
    }
    return result;
  }
}
