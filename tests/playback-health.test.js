import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../src/playback-health.js", import.meta.url),
  "utf8"
);
const context = vm.createContext({});
vm.runInContext(source, context);
const {
  LIVE_OPTIONS,
  shouldPreemptivelyRecover,
  recoveryCooldownRemaining
} = context.BiliCdnPlaybackHealth;

const samples = (buffers, {
  startTime = 30,
  stepMs = 2000,
  playbackRate = 1,
  visible = true,
  playing = true
} = {}) =>
  buffers.map((bufferedAhead, index) => ({
    at: index * stepMs,
    currentTime:
      startTime + (index * stepMs * playbackRate) / 1000,
    bufferedAhead,
    visible,
    playing,
    seeking: false
  }));

test("持续下降且低于八秒时提前恢复", () => {
  assert.equal(
    shouldPreemptivelyRecover(
      samples([24, 22, 20, 18, 16, 14, 12, 10, 8])
    ),
    true
  );
});

test("正常分片造成的锯齿缓冲不会误触发", () => {
  assert.equal(
    shouldPreemptivelyRecover(
      samples([12, 9, 13, 10, 7, 9, 7])
    ),
    false
  );
});

test("刚开始播放时的低缓冲增长不会误触发", () => {
  assert.equal(
    shouldPreemptivelyRecover(samples([2, 3, 4, 5, 6, 7, 8])),
    false
  );
});

test("拖动进度条造成的时间跳跃不会触发", () => {
  const seekSamples = samples([20, 18, 16, 14, 12, 10, 8]);
  seekSamples[3].currentTime = 180;
  seekSamples[4].currentTime = 182;
  seekSamples[5].currentTime = 184;
  seekSamples[6].currentTime = 186;
  assert.equal(shouldPreemptivelyRecover(seekSamples), false);
});

test("缓冲已经耗尽时交给既有硬卡顿兜底", () => {
  assert.equal(
    shouldPreemptivelyRecover(samples([12, 10, 8, 6, 4, 2, 0.2])),
    false
  );
});

test("后台或暂停播放不会触发", () => {
  const draining = [20, 18, 16, 14, 12, 10, 8];
  assert.equal(
    shouldPreemptivelyRecover(samples(draining, { visible: false })),
    false
  );
  assert.equal(
    shouldPreemptivelyRecover(samples(draining, { playing: false })),
    false
  );
});

test("直播阈值在秒级缓冲净流出时提前恢复，点播阈值不触发", () => {
  const liveDrain = samples([7, 6.5, 5.5, 4.5, 3.8, 3.2]);
  assert.equal(shouldPreemptivelyRecover(liveDrain, LIVE_OPTIONS), true);
  assert.equal(shouldPreemptivelyRecover(liveDrain), false);
});

test("直播一秒分段的正常锯齿缓冲不会误触发", () => {
  assert.equal(
    shouldPreemptivelyRecover(
      samples([3.5, 4.5, 3.6, 4.4, 3.5, 4.3, 3.4]),
      LIVE_OPTIONS
    ),
    false
  );
});

test("直播缓冲耗尽或仍然充足时不做预防切换", () => {
  assert.equal(
    shouldPreemptivelyRecover(
      samples([4, 3.2, 2.4, 1.6, 0.9, 0.3]),
      LIVE_OPTIONS
    ),
    false
  );
  assert.equal(
    shouldPreemptivelyRecover(
      samples([11, 10, 9, 8, 7, 6]),
      LIVE_OPTIONS
    ),
    false
  );
});

test("同一 host 保留长冷却，不同 host 使用较短保护期", () => {
  const base = {
    now: 20_000,
    lastAt: 10_000,
    lastHost: "slow.bilivideo.com",
    cooldownMs: 15_000,
    minimumIntervalMs: 7_000
  };
  assert.equal(
    recoveryCooldownRemaining({
      ...base,
      currentHost: "slow.bilivideo.com"
    }),
    5_000
  );
  assert.equal(
    recoveryCooldownRemaining({
      ...base,
      currentHost: "next.bilivideo.com"
    }),
    0
  );
  assert.equal(
    recoveryCooldownRemaining({
      ...base,
      now: 14_000,
      currentHost: "next.bilivideo.com"
    }),
    3_000
  );
  assert.equal(
    recoveryCooldownRemaining({
      ...base,
      now: 30_000,
      currentHost: "slow.bilivideo.com"
    }),
    0
  );
});
