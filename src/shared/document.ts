export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Panel {
  id: string;
  rect: Rect;
  dialogue: string;
  speaker: string;
  sound: "rain" | "pulse" | "wind";
  duration: number;
}
export interface ComicPage {
  id: string;
  title: string;
  image: string;
  width: number;
  height: number;
  panels: Panel[];
}
export interface Chapter {
  id: string;
  title: string;
  subtitle: string;
  pages: ComicPage[];
}
export interface ComicDocument {
  version: 1;
  id: string;
  title: string;
  author: string;
  chapters: Chapter[];
  voices?: VoiceTrack[];
}
export interface SentenceCue {
  id: string;
  panelId: string;
  index: number;
  text: string;
  start: number;
  end: number;
  tail: number;
  confirmed: boolean;
}
export interface VoiceTrack {
  chapterId: string;
  name: string;
  audio: string;
  duration: number;
  cues: SentenceCue[];
}
export interface VoiceCursor {
  chapterId: string;
  cueId: string;
}
export interface ReadingLocation {
  chapterId: string;
  pageId: string;
  panelId: string;
  zoom: number;
  x: number;
  y: number;
}
export interface Bookmark {
  id: string;
  label: string;
  location: ReadingLocation;
  created: number;
}
export type ReadingMode = "page" | "panel";
