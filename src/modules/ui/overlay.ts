import {
  ANIMATING_CLASS,
  CURRENT_LYRICS_CLASS,
  LOG_PREFIX,
  PAUSED_CLASS,
  PRE_ANIMATING_CLASS,
  WORD_CLASS,
} from "@constants";
import { renderLyricsIntoContainer } from "@modules/lyrics/lyricsRenderer";
import type { Lyric } from "@modules/lyrics/providers/shared";
import { log } from "@utils";

const OVERLAY_ID = "blyrics-overlay";
const OVERLAY_HEADER_ID = "blyrics-overlay-header";
const OVERLAY_CONTAINER_ID = "blyrics-overlay-lyrics";
const OVERLAY_TOGGLE_BTN_ID = "blyrics-overlay-toggle";
const OVERLAY_CLOSE_BTN_ID = "blyrics-overlay-close";

let overlayEl: HTMLElement | null = null;
let lyricsContainer: HTMLElement | null = null;
let currentTime = 0;
let lyrics: Lyric[] = [];
let syncType: "richsync" | "synced" | "none" = "none";
let rafId: number | null = null;
let isVisible = false;

function injectStyles(): void {
  if (document.getElementById("blyrics-overlay-style")) return;
  const style = document.createElement("style");
  style.id = "blyrics-overlay-style";
  style.textContent = `
#${OVERLAY_ID} {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  bottom: 80px;
  right: 20px;
  width: 360px;
  max-height: 480px;
  background: var(--blyrics-bg-color, #0a0b0c);
  border: 1px solid var(--blyrics-footer-border-color, rgba(255,255,255,0.08));
  border-radius: var(--blyrics-small-border-radius, 12px);
  box-shadow: var(--blyrics-box-shadow, 0 4px 24px rgba(0,0,0,0.6));
  font-family: var(--blyrics-font-family, Satoshi, Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif);
  color: var(--blyrics-ui-text-color, #e0e0e0);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: opacity 0.2s ease, transform 0.2s ease;
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
}
#${OVERLAY_ID}.blyrics-overlay--visible {
  opacity: 1;
  transform: translateY(0);
  pointer-events: all;
}
#${OVERLAY_ID}.blyrics-overlay--hidden {
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
}
#${OVERLAY_HEADER_ID} {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--blyrics-footer-border-color, rgba(255,255,255,0.06));
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
#${OVERLAY_HEADER_ID}:active { cursor: grabbing; }
#${OVERLAY_HEADER_ID} span {
  font-size: 13px;
  font-weight: 600;
  opacity: 0.7;
}
#${OVERLAY_CLOSE_BTN_ID} {
  background: none;
  border: none;
  color: var(--blyrics-footer-text-color, rgba(255,255,255,0.5));
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
}
#${OVERLAY_CLOSE_BTN_ID}:hover {
  background: var(--blyrics-vote-hover-color, rgba(255,255,255,0.1));
  color: var(--blyrics-ui-text-color, #fff);
}
#${OVERLAY_CONTAINER_ID} {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  scroll-behavior: smooth;
  min-height: 60px;
  --blyrics-font-size: 1.2rem;
  --blyrics-translated-font-size: 0.95rem;
  --blyrics-padding: 0.5rem;
  --blyrics-line-height: 1.4;
}
#${OVERLAY_CONTAINER_ID}::-webkit-scrollbar { width: 4px; }
#${OVERLAY_CONTAINER_ID}::-webkit-scrollbar-track { background: transparent; }
#${OVERLAY_CONTAINER_ID}::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
#${OVERLAY_CONTAINER_ID} .blyrics--word.blyrics--animating.blyrics--paused::after {
  transition-duration: 0s, 0s, 0s !important;
}
.blyrics-overlay-empty {
  text-align: center;
  padding: 24px 0;
  font-size: 13px;
  opacity: 0.4;
  font-style: italic;
  color: var(--blyrics-ui-text-color, #e0e0e0);
}
#${OVERLAY_TOGGLE_BTN_ID} {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  bottom: 24px;
  right: 20px;
  width: 44px;
  height: 44px;
  border-radius: 22px;
  background: var(--blyrics-bg-color, #0a0b0c);
  border: 1px solid var(--blyrics-footer-border-color, rgba(255,255,255,0.08));
  box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  color: var(--blyrics-ui-text-color, #e0e0e0);
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
#${OVERLAY_TOGGLE_BTN_ID}:hover { background: var(--blyrics-vote-hover-color, #1a1b1c); }
`;
  document.head.appendChild(style);
}

function createToggleButton(): HTMLElement {
  let btn = document.getElementById(OVERLAY_TOGGLE_BTN_ID);
  if (btn) return btn;
  btn = document.createElement("button");
  btn.id = OVERLAY_TOGGLE_BTN_ID;
  btn.textContent = "♪";
  btn.title = "Toggle lyrics overlay";
  btn.addEventListener("click", toggle);
  document.body.appendChild(btn);
  return btn;
}

function createOverlay(): HTMLElement {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;

  el = document.createElement("div");
  el.id = OVERLAY_ID;

  const header = document.createElement("div");
  header.id = OVERLAY_HEADER_ID;
  const title = document.createElement("span");
  title.textContent = "Lyrics";
  const closeBtn = document.createElement("button");
  closeBtn.id = OVERLAY_CLOSE_BTN_ID;
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", hide);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const container = document.createElement("div");
  container.id = OVERLAY_CONTAINER_ID;

  el.appendChild(header);
  el.appendChild(container);
  document.body.appendChild(el);

  // Dragging
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let offsetX = 0;
  let offsetY = 0;

  header.addEventListener("mousedown", (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = el!.getBoundingClientRect();
    offsetX = dragStartX - rect.left;
    offsetY = dragStartY - rect.top;
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging || !el) return;
    el.style.left = `${e.clientX - offsetX}px`;
    el.style.top = `${e.clientY - offsetY}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });

  return el;
}

function renderOverlayLyrics(): void {
  const container = document.getElementById(OVERLAY_CONTAINER_ID);
  if (!container) return;

  if (lyrics.length === 0) {
    container.innerHTML = '<div class="blyrics-overlay-empty">Waiting for lyrics...</div>';
    return;
  }

  try {
    lyricsContainer = document.createElement("div");
    const rendered = renderLyricsIntoContainer(lyricsContainer, lyrics, {
      onSeek: (time) => {
        document.dispatchEvent(new CustomEvent("blyrics-seek-to", { detail: time }));
      },
    });
    syncType = rendered.syncType;
    container.replaceChildren(lyricsContainer);
  } catch {
    container.innerHTML = '<div class="blyrics-overlay-empty">Render error</div>';
  }
}

function highlightOverlayLyrics(): void {
  if (!lyricsContainer || lyrics.length === 0) return;

  const lineEls = lyricsContainer.querySelectorAll<HTMLElement>(".blyrics--line");
  let activeLineIndex = -1;

  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].startTimeMs / 1000) {
      activeLineIndex = i;
      break;
    }
  }

  lineEls.forEach((el, i) => {
    if (i === activeLineIndex) {
      el.classList.add(CURRENT_LYRICS_CLASS);
      const words = el.querySelectorAll<HTMLElement>(`.${WORD_CLASS}`);
      words.forEach((word) => {
        const wordTime = parseFloat(word.dataset.time || "0") * 1000;
        const wordDur = parseFloat(word.dataset.duration || "0") * 1000;
        const wordEnd = wordTime + wordDur;

        if (word.classList.contains("blyrics--zero-duration") || wordDur === 0) return;

        if (currentTime * 1000 >= wordTime && currentTime * 1000 < wordEnd) {
          word.classList.add(ANIMATING_CLASS);
          word.classList.remove(PRE_ANIMATING_CLASS, PAUSED_CLASS);
        } else if (currentTime * 1000 < wordTime) {
          word.classList.remove(ANIMATING_CLASS, PAUSED_CLASS);
          word.classList.add(PRE_ANIMATING_CLASS);
        } else {
          word.classList.remove(PRE_ANIMATING_CLASS);
          word.classList.add(ANIMATING_CLASS);
          word.classList.add(PAUSED_CLASS);
        }
      });
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      el.classList.remove(CURRENT_LYRICS_CLASS);
      const words = el.querySelectorAll<HTMLElement>(`.${WORD_CLASS}`);
      words.forEach((word) => {
        word.classList.remove(ANIMATING_CLASS, PRE_ANIMATING_CLASS, PAUSED_CLASS);
      });
    }
  });
}

function animationLoop(): void {
  highlightOverlayLyrics();
  rafId = requestAnimationFrame(animationLoop);
}

// --- Public API ---

export function setOverlayLyrics(newLyrics: Lyric[], newSyncType: "richsync" | "synced" | "none"): void {
  lyrics = newLyrics;
  syncType = newSyncType;
  if (isVisible) renderOverlayLyrics();
}

export function updateOverlayTime(time: number): void {
  currentTime = time;
}

export function updateOverlaySongInfo(song?: string, artist?: string): void {
  const header = document.getElementById(OVERLAY_HEADER_ID);
  if (!header) return;
  const title = header.querySelector("span");
  if (title) title.textContent = song ? `${song}${artist ? ` — ${artist}` : ""}` : "Lyrics";
}

export function clearOverlay(): void {
  lyrics = [];
  syncType = "none";
  lyricsContainer = null;
  const container = document.getElementById(OVERLAY_CONTAINER_ID);
  if (container) container.innerHTML = '<div class="blyrics-overlay-empty">No lyrics loaded</div>';
}

export function show(): void {
  const el = document.getElementById(OVERLAY_ID);
  if (el) {
    isVisible = true;
    el.classList.remove("blyrics-overlay--hidden");
    el.classList.add("blyrics-overlay--visible");
    renderOverlayLyrics();
    if (rafId === null) rafId = requestAnimationFrame(animationLoop);
  }
}

export function hide(): void {
  const el = document.getElementById(OVERLAY_ID);
  if (el) {
    isVisible = false;
    el.classList.remove("blyrics-overlay--visible");
    el.classList.add("blyrics-overlay--hidden");
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
}

export function toggle(): void {
  if (isVisible) hide();
  else show();
}

export function isOverlayVisible(): boolean {
  return isVisible;
}

export function initOverlay(): void {
  if (document.getElementById(OVERLAY_ID)) return;
  injectStyles();
  createToggleButton();
  createOverlay();
  log(LOG_PREFIX, "Floating overlay initialized");

  // Keyboard shortcut: Ctrl+Shift+L to toggle
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "L") {
      toggle();
    }
  });
}
