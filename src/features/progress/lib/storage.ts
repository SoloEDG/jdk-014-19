import type {
  ComicDocument,
  Bookmark,
  ReadingLocation,
  VoiceCursor,
} from "../../../shared/document";
const KEY = "panel-jdk014-v1";
export interface SavedSession {
  document: ComicDocument;
  location: ReadingLocation;
  bookmarks: Bookmark[];
  voice?: VoiceCursor | null;
}
function sanitizeVoices(document: ComicDocument) {
  if (document.voices === undefined) return;
  if (!Array.isArray(document.voices)) {
    delete document.voices;
    return;
  }
  document.voices = document.voices.filter(
    (v) =>
      v &&
      typeof v.chapterId === "string" &&
      typeof v.audio === "string" &&
      typeof v.name === "string" &&
      Number.isFinite(v.duration) &&
      Array.isArray(v.cues),
  );
  for (const v of document.voices) {
    v.cues = v.cues.filter(
      (c) =>
        c &&
        typeof c.id === "string" &&
        typeof c.panelId === "string" &&
        typeof c.text === "string" &&
        Number.isFinite(c.start) &&
        Number.isFinite(c.end),
    );
    for (const c of v.cues) {
      c.index = Number.isFinite(c.index) ? c.index : 0;
      c.tail = Number.isFinite(c.tail) ? c.tail : 0.6;
      c.confirmed = !!c.confirmed;
    }
  }
}
export function readSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as SavedSession;
    if (
      value.document?.version !== 1 ||
      !Array.isArray(value.document.chapters) ||
      !value.document.chapters.length ||
      !value.location ||
      !Array.isArray(value.bookmarks)
    )
      return null;
    for (const c of value.document.chapters) {
      if (!c.pages?.length) return null;
      for (const p of c.pages)
        if (!p.panels?.length || typeof p.image !== "string") return null;
    }
    sanitizeVoices(value.document);
    const voice = value.voice;
    value.voice =
      voice &&
      typeof voice.chapterId === "string" &&
      typeof voice.cueId === "string"
        ? voice
        : null;
    return value;
  } catch {
    return null;
  }
}
export function writeSession(value: SavedSession): string {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
    return "已保存到此浏览器";
  } catch {
    return "存储空间不足，本次修改仅保留在当前页面；请减少导入图片";
  }
}
