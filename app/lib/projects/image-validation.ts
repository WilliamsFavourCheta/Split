export const MAX_IMAGE_BYTES = 512 * 1024;
export const mimeExtensions: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" };

export function matchesImageHeader(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return mime === "image/webp" && bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}
