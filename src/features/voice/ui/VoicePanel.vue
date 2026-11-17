<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Mic,
  Play,
  Pause,
  Square,
  Upload,
  RefreshCw,
  ListPlus,
  Ear,
  Trash2,
  TriangleAlert,
} from "lucide-vue-next";
import type { VoiceController } from "../model/voice";
import { formatTime } from "../lib/cues";

const props = defineProps<{ voice: VoiceController }>();
const v = props.voice;
const {
  state,
  broken,
  message,
  position,
  track,
  rows,
  confirmedCount,
  cursorCue,
} = v;

const dragging = ref(false),
  dragValue = ref(0);
const shown = computed(() => (dragging.value ? dragValue.value : position.value));
const canPlay = computed(
  () => !!track.value && !broken.value && confirmedCount.value > 0,
);
const stateLabel = computed(() => {
  if (broken.value) return "配音已损坏";
  if (state.value === "playing") return "自动阅读中";
  if (state.value === "paused") return "已暂停";
  return "手动阅读";
});

function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void v.importTrack(file);
  input.value = "";
}
function num(e: Event): number {
  return Math.max(0, Number((e.target as HTMLInputElement).value) || 0);
}
function seekInput(e: Event) {
  dragging.value = true;
  dragValue.value = Number((e.target as HTMLInputElement).value);
}
function seekCommit(e: Event) {
  dragging.value = false;
  v.seekTo(Number((e.target as HTMLInputElement).value));
}
</script>

<template>
  <section class="voice-panel">
    <div class="section-heading">
      <span><Mic :size="14" /> 配音自动阅读</span
      ><span class="voice-state" :data-state="broken ? 'broken' : state">{{
        stateLabel
      }}</span>
    </div>

    <div v-if="!track" class="voice-empty">
      <p>
        为「当前章节」导入整章配音，给对白句子标记音频区间并试听确认后，即可逐句显现、跨格自动阅读；没有配音的格子仍按作者空镜时长停留。
      </p>
      <label class="import-button"
        ><Upload :size="15" /> 导入整章配音<input
          aria-label="导入整章配音"
          type="file"
          accept="audio/*"
          @change="pick"
      /></label>
    </div>

    <template v-else>
      <div class="voice-transport">
        <button
          class="play-sound"
          :disabled="!canPlay && state === 'idle'"
          :aria-label="state === 'playing' ? '暂停自动阅读' : '开始自动阅读'"
          :title="
            broken
              ? '配音已损坏，请重新导入'
              : confirmedCount === 0
                ? '请先确认至少一句标记'
                : state === 'playing'
                  ? '暂停'
                  : '从续读句点开始'
          "
          @click="v.play()"
        >
          <Pause v-if="state === 'playing'" :size="17" /><Play v-else :size="17" />
        </button>
        <div class="voice-seek">
          <input
            aria-label="配音进度"
            type="range"
            min="0"
            :max="track.duration"
            step="0.05"
            :value="shown"
            :disabled="broken"
            @input="seekInput"
            @change="seekCommit"
          />
          <div class="voice-time">
            <span>{{ formatTime(shown) }}</span
            ><span>{{ formatTime(track.duration) }}</span>
          </div>
        </div>
        <button
          v-if="state !== 'idle'"
          title="停止自动阅读，回到手动"
          aria-label="停止自动阅读"
          @click="v.stop()"
        >
          <Square :size="14" />
        </button>
      </div>
      <p class="voice-track-name" :title="track.name">
        {{ track.name }} · 已确认 {{ confirmedCount }}/{{ rows.length }} 句
      </p>
      <p v-if="broken" class="voice-warning">
        <TriangleAlert :size="12" /> 配音文件已损坏，已回退手动阅读；句子标记全部保留，重新导入配音即可修复。
      </p>
      <p v-if="message" class="notice" role="status">{{ message }}</p>
      <p v-if="cursorCue && state === 'idle' && !broken" class="voice-resume">
        续读句点 · <b>“{{ cursorCue.text }}”</b>，重开或点击播放从此句继续
      </p>

      <div class="voice-cues-head">
        <span>句子标记</span>
        <div>
          <button class="voice-mini-btn" @click="v.splitChapterSentences()">
            <ListPlus :size="12" /> 拆分对白句子
          </button>
          <label class="voice-mini-btn" title="重新导入配音（保留标记）"
            ><RefreshCw :size="12" /> 重新导入<input
              aria-label="重新导入配音"
              type="file"
              accept="audio/*"
              @change="pick"
          /></label>
        </div>
      </div>
      <div v-if="!rows.length" class="voice-empty-cues">
        还没有句子标记，点击「拆分对白句子」从本章对白生成草稿。
      </div>
      <div class="voice-cues">
        <div
          v-for="row in rows"
          :key="row.cue.id"
          class="voice-cue"
          :class="{
            confirmed: row.cue.confirmed,
            active: row.active,
            invalid: row.issues.length > 0,
          }"
        >
          <div class="voice-cue-top">
            <button
              class="voice-cue-label"
              :title="
                row.cue.confirmed ? '跳到此句' : '未确认，点击试听'
              "
              @click="
                row.cue.confirmed
                  ? v.jumpToCue(row.cue.id)
                  : v.audition(row.cue)
              "
            >
              <b>{{ row.speaker }}</b
              ><span>{{ row.cue.text }}</span>
            </button>
            <div class="voice-cue-actions">
              <button
                :title="row.auditioning ? '停止试听' : '试听该句区间'"
                :disabled="broken"
                @click="v.audition(row.cue)"
              >
                <Square v-if="row.auditioning" :size="12" /><Ear v-else :size="13" />
              </button>
              <button
                class="toggle"
                :class="{ on: row.cue.confirmed }"
                :aria-pressed="row.cue.confirmed"
                :title="
                  row.issues.length && !row.cue.confirmed
                    ? '存在冲突，调整后才能确认'
                    : '确认后加入自动阅读序列'
                "
                @click="v.toggleConfirm(row.cue.id)"
              >
                <i></i>
              </button>
              <button title="删除该句标记" @click="v.removeCue(row.cue.id)">
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
          <div class="voice-cue-range">
            <label
              >起<input
                type="number"
                min="0"
                step="0.1"
                :value="row.cue.start.toFixed(1)"
                @change="
                  v.updateCue(row.cue.id, { start: num($event) })
                "
            /></label>
            <label
              >止<input
                type="number"
                min="0"
                step="0.1"
                :value="row.cue.end.toFixed(1)"
                @change="v.updateCue(row.cue.id, { end: num($event) })"
            /></label>
            <label
              >留白<input
                type="number"
                min="0"
                max="10"
                step="0.1"
                :value="row.cue.tail.toFixed(1)"
                @change="v.updateCue(row.cue.id, { tail: num($event) })"
            /></label>
          </div>
          <p v-if="row.issues.length" class="voice-issue">
            <TriangleAlert :size="11" />
            {{ row.issues.join("；") }}——不会自动裁剪相邻句，请手动调整
          </p>
        </div>
      </div>
    </template>
  </section>
</template>
