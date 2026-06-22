import { LOG_PREFIX, TAB_HEADER_CLASS } from "@constants";
import type { Lyric, LyricPart } from "@modules/lyrics/providers/shared";
import { log } from "@utils";

export interface PopupState {
  lyrics: Lyric[];
  syncType: "richsync" | "synced" | "none";
  videoId?: string;
  song?: string;
  artist?: string;
  album?: string;
  duration?: number;
  source?: string;
  sourceHref?: string;
}

let currentTime = 0;
let currentPopupState: PopupState | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let isActive = false;

function sendToBackground(msg: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // background might not be ready
    });
  } catch {
    // ignore
  }
}

export function updatePopupState(state: PopupState): void {
  currentPopupState = state;
  if (isActive) {
    sendToBackground({ action: "blyrics:state", payload: state });
  }
}

export function updateCurrentTime(time: number): void {
  currentTime = time;
}

export function clearPopupState(): void {
  currentPopupState = null;
  currentTime = 0;
  if (isActive) {
    sendToBackground({ action: "blyrics:cleared" });
  }
}

function onTick(): void {
  if (!isActive || !currentPopupState) return;
  sendToBackground({
    action: "blyrics:tick",
    payload: { currentTime, state: currentPopupState },
  });
}

export function activatePopupBridge(): void {
  if (isActive) return;
  isActive = true;
  tickInterval = setInterval(onTick, 250);
  if (currentPopupState) {
    sendToBackground({ action: "blyrics:state", payload: currentPopupState });
  }
}

export function deactivatePopupBridge(): void {
  isActive = false;
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "blyrics:seek" && typeof request.payload?.time === "number") {
    log(LOG_PREFIX, `PopUp seek to ${request.payload.time}s`);
    document.dispatchEvent(new CustomEvent("blyrics-seek-to", { detail: request.payload.time }));
    sendResponse({ success: true });
    return true;
  }
  if (request.action === "blyrics:switchToLyricsTab") {
    const tabSelector = document.getElementsByClassName(TAB_HEADER_CLASS)[1] as HTMLElement | undefined;
    if (tabSelector) tabSelector.click();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === "blyrics:getState") {
    sendResponse({
      state: currentPopupState,
      currentTime,
    });
    return true;
  }
  return undefined;
});
