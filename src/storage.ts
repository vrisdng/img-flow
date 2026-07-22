import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { supabase } from './db.js';

export const BUCKET = 'image-flow';
export const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
export async function inspectImage(buffer: Buffer) {
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Image must be 20 MB or smaller.');
  const meta = await sharp(buffer).metadata(); const mime = meta.format === 'png' ? 'image/png' : meta.format === 'jpeg' ? 'image/jpeg' : meta.format === 'webp' ? 'image/webp' : '';
  if (!mime || !meta.width || !meta.height) throw new Error('Only valid PNG, JPEG, and WebP images are supported.');
  if (meta.width > 12000 || meta.height > 12000) throw new Error('Image dimensions must not exceed 12000px.');
  return { mime, width: meta.width, height: meta.height, hash: sha256(buffer), size: buffer.length };
}
async function store(buffer: Buffer, folder: string, extension: string, mime: string) {
  const storagePath = `${folder}/${sha256(buffer)}.${extension}`;
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(`Storage upload failed: ${error.message}`);
  return storagePath;
}
export const storeMaterial = (buffer: Buffer, extension: string, mime: string) => store(buffer, 'materials', extension, mime);
export const storeOutputAtomic = (buffer: Buffer, extension: string, mime: string) => store(buffer, 'outputs', extension, mime);
export async function downloadStored(storagePath: string) {
  if (!/^(materials|outputs)\/[a-f0-9]{64}\.(png|jpg|jpeg|webp)$/.test(storagePath)) throw new Error('Unsafe storage path.');
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath); if (error) throw new Error(`Stored image is missing: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}
