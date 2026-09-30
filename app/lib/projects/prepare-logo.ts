import { MAX_IMAGE_BYTES, mimeExtensions } from "./image-validation";

export async function prepareLogo(file: File) {
  if (!mimeExtensions[file.type]) throw new Error("Choose a PNG, JPG, or WebP image.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("The image must be 512 KiB or smaller.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let blob: Blob | null = null;
  for (const quality of [0.84, 0.72, 0.6]) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (blob && blob.size <= MAX_IMAGE_BYTES) break;
  }
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error("This image could not be compressed small enough. Try a simpler or smaller image.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
}
