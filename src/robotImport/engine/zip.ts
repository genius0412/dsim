/**
 * A dropped .zip, read without unpacking it all: the central directory from the file's tail (a
 * few KB, so the main thread can see what is inside before it decides where the work goes), then
 * ONE entry inflated straight into a buffer of its stated size. CAD vendors publish robots zipped:
 * goBILDA's DECODE and BIOBUZZ starter bots are 61 and 69 MB downloads holding 390 and 420 MB
 * STEP files, and a player should be able to drop the download as it is.
 *
 * DOM-free and three-free (fflate is the copy three ships, already in the engine's chunks).
 */
import { Inflate } from 'three/examples/jsm/libs/fflate.module.js';
import type { ModelFormat } from '../types';
import { ImportError } from './importError';

export interface ZipEntry {
  /** the path inside the archive */
  name: string;
  /** 0 stored, 8 deflate */
  method: number;
  compressedSize: number;
  size: number;
  /** offset of the entry's local header */
  offset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const u16 = (d: DataView, at: number): number => d.getUint16(at, true);
const u32 = (d: DataView, at: number): number => d.getUint32(at, true);
const u64 = (d: DataView, at: number): number => d.getUint32(at, true) + d.getUint32(at + 4, true) * 2 ** 32;

/** bytes [a, b) of a blob */
async function slice(file: Blob, a: number, b: number): Promise<DataView> {
  return new DataView(await file.slice(a, b).arrayBuffer());
}

/** `name` is a zip when its first four bytes say so */
export async function isZip(file: Blob): Promise<boolean> {
  if (file.size < 22) return false;
  const d = await slice(file, 0, 4);
  return u32(d, 0) === LOCAL || u32(d, 0) === EOCD;
}

/**
 * Every file in the archive (folders left out). Reads the end-of-central-directory record from the
 * last 64 KB and the directory it points at, with ZIP64 sizes and offsets when the archive has them.
 * Throws `ImportError('zip')` when the file is not a zip or its directory is damaged.
 */
export async function zipEntries(file: Blob, label: string): Promise<ZipEntry[]> {
  const bad = (why: string): ImportError => new ImportError('zip', `Couldn’t open ${label}: ${why}. Download it again, or unzip it and drop the model inside.`);
  const tailLen = Math.min(file.size, 65557);
  const tail = await slice(file, file.size - tailLen, file.size);
  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw bad('it isn’t a zip, or it is cut off');
  let count = u16(tail, at + 10);
  let dirSize = u32(tail, at + 12);
  let dirOffset = u32(tail, at + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    // ZIP64: the locator sits just before the record and names the ZIP64 end record
    const loc = at - 20;
    if (loc < 0 || u32(tail, loc) !== EOCD64_LOCATOR) throw bad('its ZIP64 directory is missing');
    const end64 = u64(tail, loc + 8);
    const e = await slice(file, end64, end64 + 56);
    if (u32(e, 0) !== EOCD64) throw bad('its ZIP64 directory is damaged');
    count = u64(e, 32);
    dirSize = u64(e, 40);
    dirOffset = u64(e, 48);
  }
  if (dirOffset + dirSize > file.size) throw bad('it is cut off');
  const dir = await slice(file, dirOffset, dirOffset + dirSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > dir.byteLength || u32(dir, p) !== CENTRAL) throw bad('its directory is damaged');
    const flags = u16(dir, p + 8);
    const method = u16(dir, p + 10);
    let compressedSize = u32(dir, p + 20);
    let size = u32(dir, p + 24);
    const nameLen = u16(dir, p + 28);
    const extraLen = u16(dir, p + 30);
    const commentLen = u16(dir, p + 32);
    let offset = u32(dir, p + 42);
    const nameBytes = new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(nameBytes);
    // the ZIP64 extra field holds, in order, whichever of the three were 0xffffffff
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(dir, x);
      const len = u16(dir, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) {
          size = u64(dir, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(dir, q);
          q += 8;
        }
        if (offset === 0xffffffff) offset = u64(dir, q);
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) out.push({ name, method, compressedSize, size, offset });
    p = xEnd + commentLen;
  }
  return out;
}

/** the part of an entry's path after its last slash */
export const entryBaseName = (name: string): string => name.split(/[\\/]/).pop() ?? name;

/** a zip's model: the entry to read, and the files that go with it (a .gltf's .bin, an .obj's .mtl) */
export interface ZipPick {
  zip: File;
  entry: ZipEntry;
  /** the entry and its companions, the entry first */
  entries: ZipEntry[];
  format: ModelFormat;
  /** the model's own file name, which the player sees */
  name: string;
}

/** a zip's model and its companions as files, the model first */
export async function unzipFiles(pick: ZipPick, onProgress?: (frac: number) => void, signal?: AbortSignal): Promise<File[]> {
  const out: File[] = [];
  const total = pick.entries.reduce((s, e) => s + e.compressedSize, 0) || 1;
  let before = 0;
  for (const e of pick.entries) {
    const bytes = await zipEntryBytes(pick.zip, e, pick.zip.name, (f) => onProgress?.((before + f * e.compressedSize) / total), signal);
    before += e.compressedSize;
    out.push(new File([bytes as Uint8Array<ArrayBuffer>], entryBaseName(e.name)));
  }
  return out;
}

/**
 * One entry's bytes, inflated in 4 MB slices of the compressed data straight into a buffer of the
 * size the directory states, so the archive is never held whole next to its contents.
 */
export async function zipEntryBytes(file: Blob, e: ZipEntry, label: string, onProgress?: (frac: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const bad = (why: string): ImportError => new ImportError('zip', `Couldn’t unzip ${entryBaseName(e.name)} from ${label}: ${why}. Download it again, or unzip it yourself and drop the file.`);
  if (e.method !== 0 && e.method !== 8) throw bad(`it is compressed a way DSIM doesn’t read (method ${e.method})`);
  const head = await slice(file, e.offset, e.offset + 30);
  if (u32(head, 0) !== LOCAL) throw bad('the archive is damaged');
  const dataAt = e.offset + 30 + u16(head, 26) + u16(head, 28);
  if (dataAt + e.compressedSize > file.size) throw bad('the archive is cut off');
  if (e.method === 0) return new Uint8Array(await file.slice(dataAt, dataAt + e.size).arrayBuffer());
  const out = new Uint8Array(e.size);
  let written = 0;
  let overflow = false;
  const inflater = new Inflate((chunk: Uint8Array) => {
    if (written + chunk.length > out.length) {
      overflow = true;
      return;
    }
    out.set(chunk, written);
    written += chunk.length;
  });
  const STEP = 4 << 20;
  for (let a = 0; a < e.compressedSize; a += STEP) {
    if (signal?.aborted) {
      const err = new Error('The import was cancelled.');
      err.name = 'AbortError';
      throw err;
    }
    const b = Math.min(e.compressedSize, a + STEP);
    const part = new Uint8Array(await file.slice(dataAt + a, dataAt + b).arrayBuffer());
    try {
      inflater.push(part, b === e.compressedSize);
    } catch {
      throw bad('the archive is damaged');
    }
    if (overflow) throw bad('it is bigger than the archive says');
    onProgress?.(b / e.compressedSize);
  }
  if (written !== out.length) throw bad('it is shorter than the archive says');
  return out;
}
