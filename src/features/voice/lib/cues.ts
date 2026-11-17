import type {
  Chapter,
  SentenceCue,
  VoiceTrack,
} from "../../../shared/document";
import { makeId } from "../../../shared/commands";

export const DEFAULT_TAIL = 0.6;

export function splitSentences(text: string): string[] {
  const parts = text.match(/[^。！？!?…\n]+[。！？!?…]*/g) ?? [];
  return parts.map((s) => s.trim()).filter(Boolean);
}

const round = (v: number) => Math.round(v * 10) / 10;

/** 为章节对白中还没有标记的句子补草稿标记；已有标记（含已确认）原样保留。 */
export function ensureCues(chapter: Chapter, track: VoiceTrack): number {
  const wanted: { panelId: string; index: number; text: string }[] = [];
  for (const page of chapter.pages)
    for (const panel of page.panels)
      splitSentences(panel.dialogue).forEach((text, index) =>
        wanted.push({ panelId: panel.id, index, text }),
      );
  const existing = new Set(track.cues.map((c) => `${c.panelId}#${c.text}`));
  const missing = wanted.filter((w) => !existing.has(`${w.panelId}#${w.text}`));
  if (!missing.length || !(track.duration > 0)) return 0;
  const weights = missing.map((m) => Math.max(0.8, m.text.length * 0.3));
  const total = weights.reduce((a, b) => a + b, 0);
  const lastEnd = track.cues.reduce((max, c) => Math.max(max, c.end), 0);
  const room = Math.max(0, track.duration * 0.98 - lastEnd);
  const scale = Math.min(1, room / total);
  let at = lastEnd;
  missing.forEach((m, i) => {
    const length = Math.max(0.3, weights[i]! * scale);
    track.cues.push({
      id: makeId("cue"),
      panelId: m.panelId,
      index: m.index,
      text: m.text,
      start: round(at),
      end: round(Math.min(track.duration, at + length)),
      tail: DEFAULT_TAIL,
      confirmed: false,
    });
    at += length;
  });
  return missing.length;
}

/**
 * 冲突只标记、不修复：重叠的相邻句双方都给出提示，
 * 修改区间绝不隐式裁剪相邻对白。
 */
export function cueIssues(
  cues: SentenceCue[],
  duration: number,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (id: string, msg: string) => {
    const list = map.get(id) ?? [];
    if (!list.includes(msg)) list.push(msg);
    map.set(id, list);
  };
  for (const c of cues) {
    if (!(c.start < c.end)) add(c.id, "区间无效（起需小于止）");
    else if (duration > 0 && c.end > duration + 0.05)
      add(c.id, "超出配音长度");
  }
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  let furthest: SentenceCue | null = null;
  for (const cue of sorted) {
    if (furthest && cue.start < furthest.end - 0.001) {
      add(furthest.id, "与后一句重叠");
      add(cue.id, "与前一句重叠");
    }
    if (!furthest || cue.end > furthest.end) furthest = cue;
  }
  return map;
}

export interface SentenceStep {
  kind: "sentence";
  panelId: string;
  cue: SentenceCue;
}
export interface DwellStep {
  kind: "dwell";
  panelId: string;
  seconds: number;
}
export type Step = SentenceStep | DwellStep;

/**
 * 自动阅读的播放序列：有已确认句子的分镜逐句播放；
 * 没有已确认句子的分镜视为空镜，按作者时长停留。
 */
export function buildSteps(
  chapter: Chapter,
  track: VoiceTrack | undefined,
): Step[] {
  const byPanel = new Map<string, SentenceCue[]>();
  for (const cue of track?.cues ?? []) {
    if (!cue.confirmed) continue;
    const list = byPanel.get(cue.panelId) ?? [];
    list.push(cue);
    byPanel.set(cue.panelId, list);
  }
  const steps: Step[] = [];
  for (const page of chapter.pages)
    for (const panel of page.panels) {
      const list = byPanel.get(panel.id)?.sort((a, b) => a.index - b.index);
      if (list?.length)
        for (const cue of list)
          steps.push({ kind: "sentence", panelId: panel.id, cue });
      else
        steps.push({
          kind: "dwell",
          panelId: panel.id,
          seconds: Math.max(0.5, panel.duration),
        });
    }
  return steps;
}

/** 把配音时间轴上的一点映射到句子：区间内取当前句，空白处取下一句。 */
export function findCueAt(
  cues: SentenceCue[],
  seconds: number,
): { cue: SentenceCue; inside: boolean } | null {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  for (const cue of sorted)
    if (seconds >= cue.start && seconds < cue.end) return { cue, inside: true };
  const upcoming = sorted.find((c) => c.start >= seconds);
  if (upcoming) return { cue: upcoming, inside: false };
  const last = sorted[sorted.length - 1];
  return last ? { cue: last, inside: false } : null;
}

export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}
