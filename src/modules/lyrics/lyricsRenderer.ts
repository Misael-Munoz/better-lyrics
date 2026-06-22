import {
  BACKGROUND_LYRIC_CLASS,
  EXPLICIT_WORD_CLASS,
  HAS_TRAILING_SPACE_CLASS,
  LYRICS_CLASS,
  RTL_CLASS,
  WORD_CLASS,
  ZERO_DURATION_ANIMATION_CLASS,
} from "@constants";
import { createInstrumentalElement } from "@modules/lyrics/createInstrumentalElement";
import { testRtl } from "@modules/lyrics/lyricParseUtils";
import type { Lyric, LyricPart } from "@modules/lyrics/providers/shared";
import { registerThemeSetting } from "@modules/settings/themeOptions";

export const disableRichsync = registerThemeSetting("blyrics-disable-richsync", false, true);
export const lineSyncedAnimationDelay = registerThemeSetting("blyrics-line-synced-animation-delay", 50, true);
export const longWordThreshold = registerThemeSetting("blyrics-long-word-threshold", 1500, true);
export const longWordWrapThreshold = registerThemeSetting("blyrics-long-word-wrap-threshold", 5, true);

export type SyncType = "richsync" | "synced" | "none";

export interface PartData {
  time: number;
  duration: number;
  lyricElement: HTMLElement;
  animationStartTimeMs: number;
}

export type LineData = {
  parts: PartData[];
  isScrolled: boolean;
  isAnimationPlayStatePlaying: boolean;
  accumulatedOffsetMs: number;
  isAnimating: boolean;
  lastAnimSetupAt: number;
  isSelected: boolean;
  height: number;
  position: number;
} & PartData;

export interface RenderedLyrics {
  lines: LineData[];
  syncType: SyncType;
}

export interface RenderOptions {
  lineSyncedAnimationDelay?: number;
  longWordWrapThreshold?: number;
  longWordThreshold?: number;
  disableRichsync?: boolean;
  onSeek?: (time: number, isAltClick: boolean, target: HTMLElement, lineElement: HTMLElement) => void;
  containerClass?: string;
}

function findNearestAgent(lyrics: Lyric[], fromIndex: number): string | undefined {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!lyrics[i].isInstrumental && lyrics[i].agent) {
      return lyrics[i].agent;
    }
  }
  for (let i = fromIndex + 1; i < lyrics.length; i++) {
    if (!lyrics[i].isInstrumental && lyrics[i].agent) {
      return lyrics[i].agent;
    }
  }
  return undefined;
}

function isNearestLyricRtl(lyrics: Lyric[], fromIndex: number): boolean {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) {
      return testRtl(lyrics[i].words);
    }
  }
  for (let i = fromIndex + 1; i < lyrics.length; i++) {
    if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) {
      return testRtl(lyrics[i].words);
    }
  }
  return false;
}

const TRAILING_ATTACHED_PUNCT_REGEX = /^[\p{Pe}\p{Pf}\p{Po}]+$/u;

function splitLongPart(part: LyricPart, threshold: number): LyricPart[] {
  let segments: string[];
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    segments = Array.from(segmenter.segment(part.words), s => s.segment);
  } catch {
    segments = Array.from(part.words);
  }

  segments = segments.reduce((acc, curr) => {
    if (acc.length > 0 && TRAILING_ATTACHED_PUNCT_REGEX.test(curr)) {
      acc[acc.length - 1] += curr;
    } else {
      acc.push(curr);
    }
    return acc;
  }, [] as string[]);

  const totalChars = part.words.length;
  const subParts: LyricPart[] = [];
  let charsBefore = 0;
  for (let i = 0; i < segments.length; i++) {
    const chunk = segments[i];
    const subStart = part.startTimeMs + Math.round((part.durationMs * charsBefore) / totalChars);
    const subEnd =
      i === segments.length - 1
        ? part.startTimeMs + part.durationMs
        : part.startTimeMs + Math.round((part.durationMs * (charsBefore + chunk.length)) / totalChars);
    subParts.push({
      startTimeMs: subStart,
      durationMs: subEnd - subStart,
      words: chunk,
      isBackground: part.isBackground,
      explicit: part.explicit,
    });
    charsBefore += chunk.length;
  }
  return subParts;
}

export function createBreakElem(lyricElement: HTMLElement, order: number) {
  const breakElm: HTMLSpanElement = document.createElement("span");
  breakElm.classList.add("blyrics--break");
  breakElm.style.order = String(order);
  lyricElement.appendChild(breakElm);
}

function groupByWordAndInsert(lyricElement: HTMLDivElement, lyricElementsBuffer: HTMLSpanElement[]) {
  let wordGroupBuffer: HTMLSpanElement[] = [];
  let isCurrentBufferBg = false;

  const pushWordGroupBuffer = () => {
    if (wordGroupBuffer.length > 0) {
      const span = document.createElement("span");
      wordGroupBuffer.forEach(word => {
        span.appendChild(word);
      });

      if (isCurrentBufferBg) {
        span.classList.add(BACKGROUND_LYRIC_CLASS);
      }

      lyricElement.appendChild(span);
      wordGroupBuffer = [];
    }
  };

  lyricElementsBuffer.forEach(part => {
    const partIsBg = part.classList.contains(BACKGROUND_LYRIC_CLASS);
    const isNonMatchingType = isCurrentBufferBg !== partIsBg;
    const hasTrailingSpace = part.classList.contains(HAS_TRAILING_SPACE_CLASS);
    const wrapAfter = part.dataset.wrapAfter === "true";

    if (isNonMatchingType) {
      pushWordGroupBuffer();
      isCurrentBufferBg = partIsBg;
    }
    wordGroupBuffer.push(part);

    if (hasTrailingSpace || wrapAfter) {
      pushWordGroupBuffer();
    }
  });

  pushWordGroupBuffer();
}

export function createLyricsLine(parts: LyricPart[], line: LineData, lyricElement: HTMLDivElement) {
  let rtlBuffer: HTMLSpanElement[] = [];
  let isAllRtl = true;

  let lyricElementsBuffer: HTMLSpanElement[] = [];
  let lastEmittedSpan: HTMLSpanElement | null = null;
  const wrapThreshold = longWordWrapThreshold.getNumberValue();

  parts = parts.flatMap(original => {
    const parts = original.words.match(/^(\s*)([\s\S]*?)(\s*)$/u);
    const returnArray: LyricPart[] = [];
    if (parts && parts.length > 0) {
      const beginWhitespace = parts[1];
      const core = parts[2];
      const endWhitespace = parts[3];
      if (core.length === 0) {
        return [original];
      }

      if (beginWhitespace.length > 0) {
        returnArray.push({
          startTimeMs: original.startTimeMs,
          words: beginWhitespace,
          durationMs: 0,
          explicit: original.explicit,
          isBackground: original.isBackground,
        });
      }
      returnArray.push({
        startTimeMs: original.startTimeMs,
        words: core,
        durationMs: original.durationMs,
        explicit: original.explicit,
        isBackground: original.isBackground,
      });
      if (endWhitespace.length > 0) {
        returnArray.push({
          startTimeMs: original.startTimeMs + original.durationMs,
          words: endWhitespace,
          durationMs: 0,
          explicit: original.explicit,
          isBackground: original.isBackground,
        });
      }
    }
    return returnArray;
  });

  parts.forEach(originalPart => {
    if (originalPart.words.trim().length === 0) {
      if (lastEmittedSpan) {
        lastEmittedSpan.classList.add(HAS_TRAILING_SPACE_CLASS);
      }
      return;
    }

    const subParts = splitLongPart(originalPart, wrapThreshold);

    subParts.forEach((part, subIdx) => {
      const isLastSub = subIdx === subParts.length - 1;
      let isRtl = testRtl(part.words);
      if (!isRtl && part.words.trim().length > 0) {
        isAllRtl = false;
        rtlBuffer.reverse().forEach(p => {
          lyricElementsBuffer.push(p);
        });
        rtlBuffer = [];
      }

      const span = document.createElement("span");
      span.classList.add(WORD_CLASS);
      if (part.durationMs === 0) {
        span.classList.add(ZERO_DURATION_ANIMATION_CLASS);
      }
      if (isRtl) {
        span.classList.add(RTL_CLASS);
      }

      const partData: PartData = {
        time: part.startTimeMs / 1000,
        duration: part.durationMs / 1000,
        lyricElement: span,
        animationStartTimeMs: Infinity,
      };

      span.textContent = part.words;
      span.dataset.time = String(partData.time);
      span.dataset.duration = String(partData.duration);
      span.dataset.content = part.words;
      span.style.setProperty("--blyrics-duration", part.durationMs + "ms");
      if (part.durationMs > longWordThreshold.getNumberValue()) {
        span.dataset.longWord = "true";
      }
      if (part.isBackground) {
        span.classList.add(BACKGROUND_LYRIC_CLASS);
      }
      if (part.explicit) {
        span.classList.add(EXPLICIT_WORD_CLASS);
      }

      if (!isLastSub) {
        span.dataset.wrapAfter = "true";
      }

      line.parts.push(partData);

      if (isRtl) {
        rtlBuffer.push(span);
      } else {
        lyricElementsBuffer.push(span);
      }

      lastEmittedSpan = span;
    });
  });

  if (isAllRtl && rtlBuffer.length > 0) {
    lyricElement.classList.add(RTL_CLASS);
    rtlBuffer.forEach(part => {
      lyricElementsBuffer.push(part);
    });
  } else if (rtlBuffer.length > 0) {
    rtlBuffer.reverse().forEach(part => {
      lyricElementsBuffer.push(part);
    });
  }

  groupByWordAndInsert(lyricElement, lyricElementsBuffer);
}

export function renderLyricsIntoContainer(
  lyricsContainer: HTMLElement,
  lyrics: Lyric[],
  options?: RenderOptions
): RenderedLyrics {
  lyricsContainer.replaceChildren();
  lyricsContainer.className = options?.containerClass ?? LYRICS_CLASS;

  const allZero = lyrics.every(item => item.startTimeMs === 0);
  let lines: LineData[] = [];
  let syncType: SyncType = allZero ? "none" : "synced";
  const effectiveLineSyncDelay = options?.lineSyncedAnimationDelay ?? lineSyncedAnimationDelay.getNumberValue();
  const effectiveDisableRichsync = options?.disableRichsync ?? disableRichsync.getBooleanValue();
  const onSeek = options?.onSeek;

  lyrics.forEach((lyricItem, lineIndex) => {
    if (lyricItem.isInstrumental) {
      const instrumentalElement = createInstrumentalElement(lyricItem.durationMs, lineIndex);
      instrumentalElement.classList.add("blyrics--line");
      instrumentalElement.dataset.time = String(lyricItem.startTimeMs / 1000);
      instrumentalElement.dataset.duration = String(lyricItem.durationMs / 1000);
      instrumentalElement.dataset.lineNumber = String(lineIndex);
      instrumentalElement.dataset.instrumental = "true";

      const agent = findNearestAgent(lyrics, lineIndex);
      if (agent) {
        instrumentalElement.dataset.agent = agent;
      }

      if (isNearestLyricRtl(lyrics, lineIndex)) {
        instrumentalElement.classList.add(RTL_CLASS);
      }

      if (!allZero && onSeek) {
        const seekTime = lyricItem.startTimeMs / 1000;
        instrumentalElement.addEventListener("click", (e) => {
          onSeek(seekTime, e.altKey, e.target as HTMLElement, instrumentalElement);
        });
      }

      const line: LineData = {
        lyricElement: instrumentalElement,
        time: lyricItem.startTimeMs / 1000,
        duration: lyricItem.durationMs / 1000,
        parts: [],
        isScrolled: false,
        animationStartTimeMs: Infinity,
        isAnimationPlayStatePlaying: false,
        accumulatedOffsetMs: 0,
        isAnimating: false,
        lastAnimSetupAt: 0,
        isSelected: false,
        height: -1,
        position: -1,
      };

      lines.push(line);
      lyricsContainer.appendChild(instrumentalElement);
      return;
    }

    if (!lyricItem.parts) {
      lyricItem.parts = [];
    }

    const item = lyricItem as Required<Pick<Lyric, "parts">> & Lyric;

    if (item.parts.length === 0 || effectiveDisableRichsync) {
      lyricItem.parts = [];
      const words = item.words.split(" ");

      words.forEach((word, index) => {
        item.parts.push({
          startTimeMs: item.startTimeMs + index * effectiveLineSyncDelay,
          words: word || " ",
          durationMs: 0,
        });
        item.parts.push({
          startTimeMs: item.startTimeMs + index * effectiveLineSyncDelay,
          words: " ",
          durationMs: 0,
        });
      });
    }

    if (!item.parts.every(part => part.durationMs === 0)) {
      syncType = "richsync";
    }

    const lyricElement = document.createElement("div");
    lyricElement.classList.add("blyrics--line");

    const line: LineData = {
      lyricElement: lyricElement,
      time: item.startTimeMs / 1000,
      duration: item.durationMs / 1000,
      parts: [],
      isScrolled: false,
      animationStartTimeMs: Infinity,
      isAnimationPlayStatePlaying: false,
      accumulatedOffsetMs: 0,
      isAnimating: false,
      lastAnimSetupAt: 0,
      isSelected: false,
      height: -1,
      position: -1,
    };

    createLyricsLine(item.parts, line, lyricElement);
    createBreakElem(lyricElement, 1);

    lyricElement.dataset.time = String(line.time);
    lyricElement.dataset.duration = String(line.duration);
    lyricElement.dataset.lineNumber = String(lineIndex);
    lyricElement.style.setProperty("--blyrics-duration", item.durationMs + "ms");
    if (item.agent) {
      lyricElement.dataset.agent = item.agent;
    }

    if (!allZero && onSeek) {
      lyricElement.addEventListener("click", e => {
        const target = e.target as HTMLElement;
        const isRichsync = syncType === "richsync";
        let seekTime: number;
        if (isRichsync) {
          if (e.altKey) {
            let wordElement = target.closest(`.${WORD_CLASS}`) as HTMLElement | null;
            if (!wordElement) {
              const words = lyricElement.querySelectorAll(`.${WORD_CLASS}`);
              let closestDist = Infinity;
              words.forEach(word => {
                const rect = word.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const dist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
                if (dist < closestDist) {
                  closestDist = dist;
                  wordElement = word as HTMLElement;
                }
              });
            }
            if (!wordElement) return;
            seekTime = parseFloat(wordElement.dataset.time || "0");
          } else {
            seekTime = parseFloat(lyricElement.dataset.time || "0");
          }
        } else {
          seekTime = parseFloat(lyricElement.dataset.time || "0");
        }
        onSeek(seekTime, e.altKey, target, lyricElement);
      });
    } else {
      lyricElement.style.cursor = "unset";
    }

    lines.push(line);
    lyricsContainer.appendChild(lyricElement);
  });

  lyricsContainer.dataset.sync = syncType;
  return { lines, syncType };
}
