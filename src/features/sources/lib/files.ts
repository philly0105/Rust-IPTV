/** File pickers that work on desktop (native dialog) and web (`<input type=file>` / `<a download>`). */

export const PLAYLIST_EXTENSIONS = ['m3u', 'm3u8', 'txt'];

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

/** Reads a user-chosen file as UTF-8 text (BOM stripped). */
export async function readFileText(file: File): Promise<string> {
  const text = await file.text();
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
