/**
 * Subtitles drawn by the built-in player (C6). Edge and WebView2 paint native cues with the
 * Windows caption theme through a browser `!important` rule that page CSS cannot beat, so the
 * user's colour, size and background would be ignored. Instead every subtitle track that turns
 * `showing` is taken over: it is set to `hidden` (the browser keeps its cues and `cuechange`
 * events but draws nothing) and its active cues are drawn here, in an overlay over the video
 * styled by the `--sub-*` variables (player.css) and placed at `cueLine(subtitlePosition)`.
 * Loaded after the player (InlinePlayer imports it lazily).
 *
 * The browser's picture-in-picture window shows the video only, not this overlay, so while the
 * video is in it the tracks that are on go back to `showing` and the browser draws them there,
 * in the system caption style; the overlay is hidden until the video leaves it.
 */

import { peekSettings, subscribeSettings } from '../store';
import { cueLine } from './style';
import { drawTrack, isDrawnTrack, releaseTrack, showDrawnTracks } from './tracks';

function isSubtitleTrack(t: TextTrack): boolean {
  return t.kind === 'subtitles' || t.kind === 'captions';
}

/** Cue text without WebVTT tags, for cues the browser cannot turn into nodes. */
export function plainCueText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** One cue as safe nodes: the browser's parsed cue (`getCueAsHTML`) or its plain text. */
function cueNode(cue: TextTrackCue): Node {
  const vtt = cue as TextTrackCue & { getCueAsHTML?: () => DocumentFragment; text?: string };
  if (typeof vtt.getCueAsHTML === 'function') return vtt.getCueAsHTML();
  return document.createTextNode(plainCueText(vtt.text ?? ''));
}

/** Overlay line position: the cue's bottom edge sits at `cueLine` percent of the height. */
export function overlayBottom(position: number): string {
  return `${100 - cueLine(position)}%`;
}

/**
 * Draws the subtitles of `el` into `box` until the returned stop. `box` is an empty element over
 * the video that the player owns; it is filled with one block per active cue.
 */
export function bindSubtitleOverlay(el: HTMLMediaElement, box: HTMLElement): () => void {
  const bound = new Set<TextTrack>();
  const line = document.createElement('div');
  line.className = 'player-subs-line';
  box.replaceChildren(line);
  /** The video is in the browser's picture-in-picture window, which draws the cues itself. */
  let pip = typeof document !== 'undefined' && document.pictureInPictureElement === el;

  const render = (): void => {
    line.style.bottom = overlayBottom(peekSettings()?.subtitlePosition ?? 0);
    box.hidden = pip;
    const blocks: Node[] = [];
    for (let i = 0; !pip && i < el.textTracks.length; i++) {
      const t = el.textTracks[i];
      if (!t || !isSubtitleTrack(t) || !isDrawnTrack(t)) continue;
      const cues = t.activeCues;
      for (let c = 0; cues && c < cues.length; c++) {
        const cue = cues[c];
        if (!cue) continue;
        const block = document.createElement('div');
        const text = document.createElement('span');
        text.className = 'player-sub-cue';
        text.dir = 'auto';
        text.appendChild(cueNode(cue));
        block.appendChild(text);
        blocks.push(block);
      }
    }
    line.replaceChildren(...blocks);
    box.dataset.cues = String(blocks.length);
  };

  const bind = (t: TextTrack | null | undefined): void => {
    if (!t || bound.has(t) || !isSubtitleTrack(t)) return;
    bound.add(t);
    t.addEventListener('cuechange', render);
  };
  /**
   * A track an engine or a file turned on is drawn here; one turned off is let go. In
   * picture-in-picture a track that is on stays `showing` for the browser, and one turned
   * `hidden` was turned off (hls.js hides its track on Off), so it is let go as well.
   */
  const takeOver = (): void => {
    for (let i = 0; i < el.textTracks.length; i++) {
      const t = el.textTracks[i];
      if (!t || !isSubtitleTrack(t)) continue;
      bind(t);
      if (t.mode === 'showing') drawTrack(t, pip);
      else if (t.mode === 'disabled' || pip) releaseTrack(t);
    }
    render();
  };
  const onEnterPip = (): void => {
    pip = true;
    showDrawnTracks(el);
    takeOver();
  };
  const onLeavePip = (): void => {
    pip = false;
    takeOver();
  };
  const onAdd = (e: TrackEvent): void => {
    bind(e.track as TextTrack | null);
    takeOver();
  };

  if (pip) showDrawnTracks(el);
  takeOver();
  el.addEventListener('enterpictureinpicture', onEnterPip);
  el.addEventListener('leavepictureinpicture', onLeavePip);
  el.textTracks.addEventListener('addtrack', onAdd);
  el.textTracks.addEventListener('removetrack', render);
  el.textTracks.addEventListener('change', takeOver);
  const unSettings = subscribeSettings(render);
  return () => {
    unSettings();
    el.removeEventListener('enterpictureinpicture', onEnterPip);
    el.removeEventListener('leavepictureinpicture', onLeavePip);
    el.textTracks.removeEventListener('addtrack', onAdd);
    el.textTracks.removeEventListener('removetrack', render);
    el.textTracks.removeEventListener('change', takeOver);
    for (const t of bound) t.removeEventListener('cuechange', render);
    bound.clear();
    box.replaceChildren();
    box.hidden = false;
    delete box.dataset.cues;
  };
}
