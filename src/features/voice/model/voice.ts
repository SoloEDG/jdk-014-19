import { ref, computed, watch, onBeforeUnmount, type Ref } from "vue";
import type {
  ComicDocument,
  Panel,
  SentenceCue,
  VoiceCursor,
} from "../../../shared/document";
import type { useReader } from "../../reader/model/reader";
import {
  buildSteps,
  cueIssues,
  ensureCues,
  findCueAt,
  type Step,
} from "../lib/cues";

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const TICK_MS = 100;
/** tick 间隔超过该值视为设备休眠/标签页冻结，立即整体暂停，防止墙钟抢跑 */
const HEARTBEAT_MS = 1200;

type Phase =
  | { kind: "listen"; cueId: string }
  | {
      kind: "hold";
      after: { cue?: string; dwell?: string };
      remaining: number;
      until: number;
    };

export function useVoice(
  doc: Ref<ComicDocument>,
  reader: ReturnType<typeof useReader>,
  savedCursor: VoiceCursor | null,
) {
  const state = ref<"idle" | "playing" | "paused">("idle"),
    broken = ref(false),
    message = ref(""),
    position = ref(0),
    cursor = ref<VoiceCursor | null>(savedCursor),
    currentId = ref(""),
    auditionId = ref("");

  const chapter = computed(() => reader.current.value.chapter),
    track = computed(
      () =>
        doc.value.voices?.find(
          (v) => v.chapterId === reader.location.value.chapterId,
        ) ?? null,
    ),
    cues = computed(() => track.value?.cues ?? []),
    issues = computed(() => cueIssues(cues.value, track.value?.duration ?? 0)),
    steps = computed<Step[]>(() =>
      chapter.value ? buildSteps(chapter.value, track.value ?? undefined) : [],
    ),
    confirmedCount = computed(
      () => cues.value.filter((c) => c.confirmed).length,
    );

  function panelOf(panelId: string): Panel | undefined {
    for (const c of doc.value.chapters)
      for (const p of c.pages)
        for (const panel of p.panels) if (panel.id === panelId) return panel;
    return undefined;
  }

  const currentCue = computed(
    () => cues.value.find((c) => c.id === currentId.value) ?? null,
  );
  const subtitle = computed(() => {
    const cue = currentCue.value;
    if (!cue || (state.value === "idle" && !auditionId.value)) return null;
    return {
      text: cue.text,
      speaker: panelOf(cue.panelId)?.speaker ?? "旁白",
    };
  });
  const cursorCue = computed(() => {
    if (cursor.value?.chapterId !== chapter.value?.id) return null;
    return cues.value.find((c) => c.id === cursor.value?.cueId) ?? null;
  });
  const rows = computed(() =>
    cues.value.map((cue) => ({
      cue,
      speaker: panelOf(cue.panelId)?.speaker ?? "旁白",
      issues: issues.value.get(cue.id) ?? [],
      active: cue.id === currentId.value,
      auditioning: cue.id === auditionId.value,
    })),
  );

  // ---- 音频元素与混合时钟 ----
  const audio = new Audio();
  audio.preload = "auto";
  let phase: Phase = { kind: "hold", after: {}, remaining: 0, until: 0 };
  let generation = 0;
  let timer = 0;
  let lastTick = 0;
  let internalPauses = 0;
  let expectedPanel = reader.location.value.panelId;

  /** 引擎内部暂停统一走这里并计数，pause 事件据此区分外部（系统/设备）暂停 */
  function pauseAudio() {
    if (audio.paused) return;
    internalPauses++;
    audio.pause();
  }

  function startTicker() {
    stopTicker();
    lastTick = Date.now();
    timer = window.setInterval(tick, TICK_MS);
  }
  function stopTicker() {
    window.clearInterval(timer);
    timer = 0;
  }
  const cueIndex = (cueId: string) =>
    steps.value.findIndex((s) => s.kind === "sentence" && s.cue.id === cueId);
  const dwellIndex = (panelId: string) =>
    steps.value.findIndex((s) => s.kind === "dwell" && s.panelId === panelId);

  function applyPanel(panelId: string) {
    if (reader.location.value.panelId === panelId) return;
    expectedPanel = panelId;
    reader.dispatch({ type: "panel", id: panelId });
  }

  function enterStep(i: number, gen: number) {
    if (gen !== generation) return;
    const step = steps.value[i];
    if (!step) return finish();
    applyPanel(step.panelId);
    if (step.kind === "dwell") {
      currentId.value = "";
      auditionId.value = "";
      pauseAudio();
      phase = {
        kind: "hold",
        after: { dwell: step.panelId },
        remaining: step.seconds * 1000,
        until: Date.now() + step.seconds * 1000,
      };
      return;
    }
    const cue = step.cue;
    currentId.value = cue.id;
    auditionId.value = "";
    cursor.value = {
      chapterId: reader.location.value.chapterId,
      cueId: cue.id,
    };
    if (audio.currentTime < cue.start - 0.04 || audio.currentTime >= cue.end)
      audio.currentTime = cue.start;
    phase = { kind: "listen", cueId: cue.id };
    const played = audio.play();
    if (played)
      played.catch(() => {
        if (gen === generation && state.value === "playing") {
          pause();
          message.value = "浏览器暂停了配音，请点击继续";
        }
      });
  }

  function tick() {
    const now = Date.now();
    if (now - lastTick > HEARTBEAT_MS) {
      lastTick = now;
      if (state.value === "playing") pause();
      return;
    }
    lastTick = now;
    if (state.value !== "playing") return;
    if (phase.kind === "listen") {
      const cueId = phase.cueId;
      const i = cueIndex(cueId);
      const cue = i >= 0 ? cues.value.find((c) => c.id === cueId) : null;
      if (i < 0 || !cue) return stop(); // 当前句被删除/取消确认
      if (audio.currentTime + 0.03 < cue.end && !audio.ended) return;
      const next = steps.value[i + 1];
      const seamless =
        next?.kind === "sentence" &&
        cue.tail <= 0.05 &&
        next.cue.start <= audio.currentTime + 0.15 &&
        next.cue.start >= cue.end - 0.5;
      if (seamless) return enterStep(i + 1, generation);
      if (!audio.ended) pauseAudio();
      if (cue.tail > 0.02) {
        phase = {
          kind: "hold",
          after: { cue: cue.id },
          remaining: cue.tail * 1000,
          until: Date.now() + cue.tail * 1000,
        };
        return;
      }
      enterStep(i + 1, generation);
      return;
    }
    if (now < phase.until) return;
    const next = phase.after.cue
      ? cueIndex(phase.after.cue) + 1
      : phase.after.dwell
        ? dwellIndex(phase.after.dwell) + 1
        : -1;
    if (next <= 0) return stop(); // 锚点已失效
    enterStep(next, generation);
  }

  function pause() {
    if (state.value !== "playing") return;
    state.value = "paused";
    if (phase.kind === "hold")
      phase.remaining = Math.max(0, phase.until - Date.now());
    pauseAudio();
    stopTicker();
  }

  function resume() {
    if (state.value !== "paused" || !track.value || broken.value) return;
    state.value = "playing";
    if (phase.kind === "hold") phase.until = Date.now() + phase.remaining;
    startTicker();
    if (phase.kind === "listen") {
      const played = audio.play();
      if (played)
        played.catch(() => {
          pause();
          message.value = "浏览器暂停了配音，请点击继续";
        });
    }
  }

  function start(fromCueId?: string) {
    message.value = "";
    if (!track.value) {
      message.value = "请先为当前章节导入整章配音";
      return;
    }
    if (broken.value) {
      message.value = "配音文件已损坏，请重新导入后再自动阅读";
      return;
    }
    if (!steps.value.some((s) => s.kind === "sentence")) {
      message.value = "还没有已确认的句子，请先试听并确认标记";
      return;
    }
    generation++;
    reader.setMode("panel");
    state.value = "playing";
    const target =
      fromCueId ??
      (cursor.value?.chapterId === chapter.value?.id
        ? cursor.value.cueId
        : "");
    const at = target ? cueIndex(target) : -1;
    startTicker();
    enterStep(at >= 0 ? at : 0, generation);
  }

  function play() {
    if (state.value === "playing") return pause();
    if (state.value === "paused") return resume();
    start();
  }

  function stop(text?: string) {
    generation++;
    state.value = "idle";
    currentId.value = "";
    auditionId.value = "";
    pauseAudio();
    stopTicker();
    if (text) message.value = text;
  }

  function finish() {
    stop("本章自动阅读完成");
  }

  /** 跳到指定已确认句；offset 省略时从句首开始。 */
  function jumpToCue(cueId: string, offset?: number) {
    if (!track.value || broken.value) return;
    const i = cueIndex(cueId);
    const cue = cues.value.find((c) => c.id === cueId);
    if (i < 0 || !cue) return;
    const playing = state.value === "playing";
    generation++;
    stopTicker();
    pauseAudio();
    state.value = playing ? "playing" : "paused";
    const step = steps.value[i]!;
    if (step.kind === "sentence") applyPanel(step.panelId);
    currentId.value = cue.id;
    auditionId.value = "";
    cursor.value = {
      chapterId: reader.location.value.chapterId,
      cueId: cue.id,
    };
    const at =
      offset === undefined
        ? cue.start
        : Math.min(Math.max(offset, cue.start), Math.max(cue.start, cue.end - 0.02));
    if (Math.abs(audio.currentTime - at) > 0.02) audio.currentTime = at;
    position.value = at;
    phase = { kind: "listen", cueId: cue.id };
    if (playing) {
      startTicker();
      const played = audio.play();
      if (played) played.catch(() => pause());
    }
  }

  /** 拖动进度条到配音时间轴上的任意点（可落在句子中部）。 */
  function seekTo(seconds: number) {
    if (!track.value || broken.value) return;
    const hit = findCueAt(
      cues.value.filter((c) => c.confirmed),
      seconds,
    );
    if (!hit) return;
    jumpToCue(hit.cue.id, hit.inside ? seconds : undefined);
  }

  /** 试听单句标记区间（不打断自动阅读状态机，先停再听）。 */
  function audition(cue: SentenceCue) {
    if (!track.value || broken.value) return;
    if (auditionId.value === cue.id) {
      auditionId.value = "";
      pauseAudio();
      return;
    }
    if (state.value !== "idle") stop();
    generation++;
    stopTicker();
    pauseAudio();
    auditionId.value = cue.id;
    currentId.value = cue.id;
    audio.currentTime = cue.start;
    position.value = cue.start;
    const gen = generation;
    const played = audio.play();
    if (played)
      played.catch(() => {
        if (gen === generation) {
          auditionId.value = "";
          message.value = "浏览器暂停了配音，请再试一次";
        }
      });
    const watcher = window.setInterval(() => {
      if (gen !== generation) return window.clearInterval(watcher);
      if (audio.currentTime >= cue.end - 0.02 || audio.ended || audio.paused) {
        window.clearInterval(watcher);
        auditionId.value = "";
        pauseAudio();
      }
    }, 60);
  }

  // ---- 标记编辑：只动当前句，绝不隐式裁剪相邻句 ----
  const round1 = (v: number) => Math.round(v * 10) / 10;
  function updateCue(
    id: string,
    patch: Partial<Pick<SentenceCue, "start" | "end" | "tail">>,
  ) {
    const cue = track.value?.cues.find((c) => c.id === id);
    if (!cue) return;
    if (patch.start !== undefined)
      cue.start = round1(Math.max(0, patch.start));
    if (patch.end !== undefined) cue.end = round1(Math.max(0, patch.end));
    if (patch.tail !== undefined)
      cue.tail = round1(Math.min(10, Math.max(0, patch.tail)));
  }
  function toggleConfirm(id: string) {
    const cue = track.value?.cues.find((c) => c.id === id);
    if (!cue) return;
    if (!cue.confirmed && (issues.value.get(id) ?? []).length) {
      message.value = "该句区间存在冲突，请先调整再确认";
      return;
    }
    cue.confirmed = !cue.confirmed;
  }
  function removeCue(id: string) {
    const t = track.value;
    if (!t) return;
    if (id === currentId.value) stop();
    t.cues = t.cues.filter((c) => c.id !== id);
    if (cursor.value?.cueId === id) cursor.value = null;
  }
  function splitChapterSentences() {
    const t = track.value,
      ch = chapter.value;
    if (!t || !ch) return;
    const added = ensureCues(ch, t);
    message.value = added
      ? `已拆分 ${added} 个句子草稿，请逐句试听、调整区间后确认`
      : "当前章节的对白句子都已在列表中";
  }

  function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("read"));
      r.readAsDataURL(file);
    });
  }
  function probeDuration(src: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = new Audio();
      const timerId = window.setTimeout(() => reject(new Error("timeout")), 8000);
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        window.clearTimeout(timerId);
        const d = probe.duration;
        Number.isFinite(d) && d > 0 ? resolve(d) : reject(new Error("bad"));
      };
      probe.onerror = () => {
        window.clearTimeout(timerId);
        reject(new Error("decode"));
      };
      probe.src = src;
    });
  }

  /** 导入/重新导入整章配音；重新导入用于修复，原有句子标记全部保留。 */
  async function importTrack(file: File) {
    if (!file.type.startsWith("audio/")) {
      message.value = "请选择音频文件（MP3、WAV、M4A 等）";
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      message.value = "配音文件不能超过 12 MB";
      return;
    }
    stop();
    message.value = "正在读取配音…";
    try {
      const data = await readFile(file);
      const duration = await probeDuration(data);
      const chapterId = reader.location.value.chapterId;
      const existing = track.value;
      if (existing) {
        existing.audio = data;
        existing.name = file.name;
        existing.duration = duration;
        broken.value = false;
        message.value = "已重新导入配音，原有句子标记已保留";
      } else {
        doc.value.voices = [
          ...(doc.value.voices ?? []),
          { chapterId, name: file.name, audio: data, duration, cues: [] },
        ];
        message.value = "配音已导入，点击「拆分对白句子」开始标记";
      }
    } catch {
      message.value = "配音文件无法解码，请更换文件";
    }
  }

  // ---- 手动跳格 / 恢复位置：配音、字幕、续读句点一起切换，旧任务作废 ----
  watch(
    () => reader.location.value.panelId,
    (panelId) => {
      if (panelId === expectedPanel) return;
      expectedPanel = panelId;
      if (state.value === "idle") {
        const step = steps.value.find((s) => s.panelId === panelId);
        if (step?.kind === "sentence")
          cursor.value = {
            chapterId: reader.location.value.chapterId,
            cueId: step.cue.id,
          };
        return;
      }
      const i = steps.value.findIndex((s) => s.panelId === panelId);
      if (i < 0) return stop();
      const step = steps.value[i]!;
      if (step.kind === "sentence") return jumpToCue(step.cue.id);
      const playing = state.value === "playing";
      generation++;
      stopTicker();
      pauseAudio();
      currentId.value = "";
      auditionId.value = "";
      phase = {
        kind: "hold",
        after: { dwell: step.panelId },
        remaining: step.seconds * 1000,
        until: Date.now() + step.seconds * 1000,
      };
      if (playing) startTicker();
      else state.value = "paused";
    },
  );

  watch(
    () => track.value?.audio,
    (src) => {
      broken.value = false;
      stop();
      if (src) {
        audio.src = src;
        audio.load();
      } else {
        audio.removeAttribute("src");
        audio.load();
      }
      position.value = 0;
    },
    { immediate: true },
  );

  audio.addEventListener("timeupdate", () => {
    position.value = audio.currentTime;
  });
  audio.addEventListener("pause", () => {
    if (internalPauses > 0) {
      internalPauses--;
      return;
    }
    // 非引擎发起的暂停（系统中断、设备暂停等）：引擎整体暂停，避免对白抢跑
    if (state.value === "playing" && phase.kind === "listen" && !audio.ended)
      pause();
  });
  audio.addEventListener("error", () => {
    if (!track.value?.audio) return;
    broken.value = true;
    stop(
      "配音文件已损坏或无法解码，已回退手动阅读；句子标记已保留，重新导入配音即可修复",
    );
  });
  function onVisibility() {
    if (document.hidden && state.value === "playing") pause();
  }
  document.addEventListener("visibilitychange", onVisibility);
  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    generation++;
    stopTicker();
    audio.pause();
    audio.removeAttribute("src");
  });

  return {
    state,
    broken,
    message,
    position,
    cursor,
    currentId,
    auditionId,
    track,
    cues,
    rows,
    issues,
    confirmedCount,
    subtitle,
    cursorCue,
    play,
    stop,
    seekTo,
    jumpToCue,
    audition,
    updateCue,
    toggleConfirm,
    removeCue,
    splitChapterSentences,
    importTrack,
  };
}
export type VoiceController = ReturnType<typeof useVoice>;
