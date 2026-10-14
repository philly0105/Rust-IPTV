/** File pickers that work on desktop (native dialog) and web (`<input type=file>` / `<a download>`). */

export const PLAYLIST_EXTENSIONS = ['m3u', 'm3u8', 'txt'];

/**
 * Largest playlist the web build reads into memory (it is sent to the core as text).
 * Bigger files stall or crash the tab; the desktop build passes a path instead and has no cap.
 */
export const MAX_WEB_FILE_BYTES = 200 * 1024 * 1024;

/** `1.2 GB`, `350 MB`, `12 KB` in the user's number format. */
export function formatFileSize(bytes: number, lang: string): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let text: string;
  try {
    text = new Intl.NumberFormat(lang, { maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 }).format(value);
  } catch {
    text = String(Math.round(value));
  }
  return `${text} ${units[unit]}`;
}

/** Desktop only: native open dialog. Returns the absolute path or null when canceled. */
export async function pickPathDesktop(opts: { title?: string; extensions: string[]; filterName: string }): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    title: opts.title,
    multiple: false,
    directory: false,
    filters: [{ name: opts.filterName, extensions: opts.extensions }],
  });
  return typeof picked === 'string' ? picked : null;
}

/** Desktop only: pick an executable (players). */
export async function pickExecutableDesktop(title: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ title, multiple: false, directory: false });
  return typeof picked === 'string' ? picked : null;
}

/** Windows-1252 code points for bytes 0x80..0x9F, as the core's `CP1252_HIGH` (undefined bytes are U+FFFD). */
const CP1252_HIGH = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

function windows1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b);
  return out;
}

/**
 * Length of the valid UTF-8 sequence at `i`, or minus the number of bytes Rust's `Utf8Error::error_len`
 * reports for an invalid one (the lead plus the continuation bytes that still fit), at least 1.
 * An incomplete sequence at the end counts as invalid over all its bytes.
 */
function utf8Step(bytes: Uint8Array, i: number): number {
  const b = bytes[i]!;
  if (b < 0x80) return 1;
  let need: number;
  let lo = 0x80;
  let hi = 0xbf;
  if (b >= 0xc2 && b <= 0xdf) need = 1;
  else if (b >= 0xe0 && b <= 0xef) {
    need = 2;
    if (b === 0xe0) lo = 0xa0;
    if (b === 0xed) hi = 0x9f;
  } else if (b >= 0xf0 && b <= 0xf4) {
    need = 3;
    if (b === 0xf0) lo = 0x90;
    if (b === 0xf4) hi = 0x8f;
  } else return -1;
  for (let k = 1; k <= need; k += 1) {
    const c = bytes[i + k];
    if (c === undefined) return -k;
    if (k === 1 ? c < lo || c > hi : c < 0x80 || c > 0xbf) return -k;
  }
  return need + 1;
}

/** One line in runs, as the core's `line_text`: valid UTF-8 stays UTF-8, each invalid sequence is Windows-1252. */
function lineText(line: Uint8Array, utf8: TextDecoder): string {
  let out = '';
  let start = 0;
  let i = 0;
  while (i < line.length) {
    const step = utf8Step(line, i);
    if (step > 0) {
      i += step;
      continue;
    }
    out += utf8.decode(line.subarray(start, i)) + windows1252(line.subarray(i, i - step));
    i -= step;
    start = i;
  }
  return out + utf8.decode(line.subarray(start));
}

/** Bytes looked at for BOM-less UTF-16 (even, so the pairs line up). */
const UTF16_SNIFF_BYTES = 512;

/**
 * BOM-less UTF-16 by where the NUL bytes fall: ASCII in UTF-16LE is `x\0` pairs, in UTF-16BE `\0x`
 * pairs, and UTF-8 or cp1252 text has no NULs. Needs at least two such pairs making up a third of
 * the pairs looked at, and almost none the other way round. `true` is LE, `false` BE.
 */
function sniffUtf16(bytes: Uint8Array): boolean | null {
  const end = Math.min(bytes.length, UTF16_SNIFF_BYTES) & ~1;
  let le = 0;
  let be = 0;
  for (let i = 0; i < end; i += 2) {
    if (bytes[i] !== 0 && bytes[i + 1] === 0) le += 1;
    else if (bytes[i] === 0 && bytes[i + 1] !== 0) be += 1;
  }
  const pairs = end / 2;
  const enough = (n: number) => n >= 2 && n * 3 >= pairs;
  if (enough(le) && be * 10 <= le) return true;
  if (enough(be) && le * 10 <= be) return false;
  return null;
}

/**
 * Decodes a playlist file as the core's `m3u::parser::decode_playlist_text` (the desktop file import)
 * does, so the web build's text import reads the same channels:
 * - UTF-16 from a byte-order mark (FF FE / FE FF) or a BOM-less `#` interleaved with NUL (`#\0` LE,
 *   `\0#` BE); a trailing odd byte is ignored, unpaired surrogates become U+FFFD.
 * - Beyond the core, other BOM-less UTF-16 is picked by where NULs fall in the first 512 bytes
 *   ({@link sniffUtf16}), for subtitle and backup files some Windows tools write that way. A
 *   playlist starts with `#`, which the rule above already covers.
 * - Otherwise a UTF-8 BOM is dropped; valid UTF-8 decodes as is. If any byte is invalid, each line
 *   decodes in runs: valid UTF-8 runs stay UTF-8, and only the invalid bytes are Windows-1252, so a
 *   file that mixes UTF-8 and cp1252 lines (or bytes) keeps both.
 */
export function decodeText(bytes: Uint8Array): string {
  const [a, b] = bytes;
  const sniffed = sniffUtf16(bytes);
  const utf16 =
    a === 0xff && b === 0xfe ? { le: true, skip: 2 }
    : a === 0xfe && b === 0xff ? { le: false, skip: 2 }
    : a === 0x23 && b === 0x00 ? { le: true, skip: 0 }
    : a === 0x00 && b === 0x23 ? { le: false, skip: 0 }
    : sniffed !== null ? { le: sniffed, skip: 0 }
    : null;
  if (utf16) {
    const body = bytes.subarray(utf16.skip, utf16.skip + ((bytes.length - utf16.skip) & ~1));
    return new TextDecoder(utf16.le ? 'utf-16le' : 'utf-16be', { ignoreBOM: true }).decode(body);
  }
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
    let out = '';
    let start = 0;
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== 0x0a) continue;
      out += lineText(body.subarray(start, i + 1), utf8);
      start = i + 1;
    }
    return out + lineText(body.subarray(start), utf8);
  }
}

/** The file's bytes, through FileReader (jsdom has no `Blob.arrayBuffer`). */
function readBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error('The file could not be read.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Reads a user-chosen file as text. The web build sends playlists to the core as text, so the
 * encoding is detected here (`decodeText`), or a UTF-16 or Windows-1252 file would arrive garbled.
 */
export async function readFileText(file: File): Promise<string> {
  return decodeText(await readBytes(file));
}

/** Base name of a path on either separator style. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Saves text through the browser's download flow (WebView2 shows its download prompt on desktop). */
export function downloadText(fileName: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
