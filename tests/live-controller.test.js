import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLiveObservation,
  chooseLiveRules,
  isLiveTab,
  liveCandidatesFor,
  queryLivePlayerUrl,
  resetLiveObservation,
  syncLiveProtocolRule,
  testLiveCandidate
} from "../src/live-controller.js";

const FLV_07 =
  "https://d1--ov-gotcha07.bilivideo.com/live-bvc/864118/live_x_y.flv?" +
  "expires=1&trid=a&sigparams=cdn&cdn=ov-gotcha07&sign=abc";
const FLV_05 =
  "https://d1--ov-gotcha05.bilivideo.com/live-bvc/504451/live_x_y.flv?" +
  "expires=2&trid=b&sigparams=cdn&cdn=ov-gotcha05&sign=def";
const PLAYLIST_207 =
  "https://d1--ov-gotcha207.bilivideo.com/live-bvc/551288/live_x_y/index.m3u8?expires=1";
const PLAYLIST_207_ROTATED =
  "https://d1--ov-gotcha207b.bilivideo.com/live-bvc/929666/live_x_y/index.m3u8?expires=2";
const PLAYLIST_OTHER_STREAM =
  "https://d1--ov-gotcha207.bilivideo.com/live-bvc/684616/live_x_y_hevc/index.m3u8?expires=1";

const liveState = (overrides = {}) => ({
  pageUrl: "https://live.bilibili.com/721",
  observedHost: "",
  sampleUrl: "",
  sampleRange: "",
  livePlaylistUrl: "",
  playurlUrls: [],
  playurlVideoUrls: [],
  autoHost: "",
  autoAttempted: false,
  nextAutoRefreshCheckAt: 0,
  benchmarks: [],
  stalledHosts: [],
  ...overrides
});

test("识别直播标签页并支持硬重置观测", () => {
  assert.equal(isLiveTab(liveState()), true);
  assert.equal(
    isLiveTab(liveState({ pageUrl: "https://www.bilibili.com/video/BV1x" })),
    false
  );
  const state = liveState({
    observedHost: "a",
    sampleUrl: FLV_07,
    livePlaylistUrl: PLAYLIST_207,
    playurlUrls: [FLV_07],
    autoHost: "a",
    autoAttempted: true,
    benchmarks: [{}]
  });
  resetLiveObservation(state);
  assert.equal(state.observedHost, "");
  assert.equal(state.livePlaylistUrl, "");
  assert.deepEqual(state.playurlUrls, []);
  assert.equal(state.autoAttempted, false);
  assert.deepEqual(state.benchmarks, []);
});

test("观测：播放列表锚定流族，换流重置选择，轮换集群不重置", () => {
  const state = liveState({ autoHost: "keep", autoAttempted: true });
  let outcome = applyLiveObservation(state, new URL(PLAYLIST_207));
  assert.equal(outcome.familyChanged, false);
  assert.equal(state.livePlaylistUrl, PLAYLIST_207);
  assert.equal(state.autoHost, "keep");

  outcome = applyLiveObservation(state, new URL(PLAYLIST_207_ROTATED));
  assert.equal(outcome.familyChanged, false, "同流换集群不算换流");
  assert.equal(state.autoHost, "keep");

  state.benchmarks = [{ host: "old" }];
  outcome = applyLiveObservation(state, new URL(PLAYLIST_OTHER_STREAM));
  assert.equal(outcome.familyChanged, true, "流名变化触发重置");
  assert.equal(state.autoHost, "");
  assert.equal(state.autoAttempted, false);
  assert.deepEqual(state.benchmarks, []);
});

test("观测：FLV 可锚定样本，HLS 分段不可", () => {
  const state = liveState();
  applyLiveObservation(
    state,
    new URL(
      "https://d1--ov-gotcha207.bilivideo.com/live-bvc/551288/live_x_y/1787.m4s"
    )
  );
  assert.equal(state.sampleUrl, "", "分段不锚定流族");
  assert.equal(state.observedHost, "d1--ov-gotcha207.bilivideo.com");

  applyLiveObservation(state, new URL(FLV_07));
  assert.equal(state.sampleUrl, FLV_07);
});

test("直播候选只含观测、签发与自定义节点", () => {
  const state = liveState({
    observedHost: "d1--ov-gotcha07.bilivideo.com",
    sampleUrl: FLV_07,
    playurlUrls: [FLV_07, FLV_05, PLAYLIST_207]
  });
  const config = {
    customHosts: ["upos-sz-mirrorcos.bilivideo.com"],
    disabledHosts: ["d1--ov-gotcha05.bilivideo.com"]
  };
  const candidates = liveCandidatesFor(config, state);
  const hosts = candidates.map((item) => item.host);
  assert.deepEqual(hosts, [
    "d1--ov-gotcha07.bilivideo.com",
    "d1--ov-gotcha05.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com"
  ]);
  assert.equal(
    candidates.find((item) => item.host === "d1--ov-gotcha05.bilivideo.com")
      .disabled,
    true
  );
  assert.equal(
    candidates.some((item) => item.source === "builtin"),
    false
  );
});

test("规则选择：跨集群双规则，兄弟或池外目标退回 host 替换", () => {
  const ruleIds = [1000000042, 1100000042, 1200000042];
  const state = liveState({
    sampleUrl: FLV_07,
    playurlUrls: [FLV_07, FLV_05]
  });
  const cross = chooseLiveRules({
    tabId: 42,
    ruleIds,
    state,
    targetHost: "d1--ov-gotcha05.bilivideo.com"
  });
  assert.equal(cross.length, 2);
  assert.equal(cross[0].action.redirect.url, FLV_05);

  const absent = chooseLiveRules({
    tabId: 42,
    ruleIds,
    state,
    targetHost: "d1--ov-gotcha07b.bilivideo.com"
  });
  assert.deepEqual(absent, [], "池外目标交回 host 替换");
});

test("向播放器查询流地址：只接受直播白名单 URL", async () => {
  assert.equal(
    await queryLivePlayerUrl(1, async () => ({ ok: true, url: FLV_07 })),
    FLV_07
  );
  assert.equal(
    await queryLivePlayerUrl(1, async () => ({
      ok: true,
      url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.m4s"
    })),
    "",
    "点播 URL 不能当直播流族"
  );
  assert.equal(
    await queryLivePlayerUrl(1, async () => {
      throw new Error("no bridge");
    }),
    ""
  );
});

test("协议规则同步：FLV 增规则，自动档只删除", async () => {
  const calls = [];
  const updateSessionRules = async (options) => calls.push(options);
  await syncLiveProtocolRule({
    preference: "flv",
    ruleId: 900000,
    updateSessionRules
  });
  assert.equal(calls[0].addRules[0].id, 900000);
  assert.deepEqual(
    calls[0].addRules[0].action.redirect.transform.queryTransform
      .addOrReplaceParams,
    [{ key: "protocol", value: "0" }]
  );
  await syncLiveProtocolRule({
    preference: "auto",
    ruleId: 900000,
    updateSessionRules
  });
  assert.deepEqual(calls[1], { removeRuleIds: [900000] });
});

const makeReader = (chunks) => {
  let index = 0;
  return {
    read: async () =>
      index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true, value: undefined },
    cancel: async () => {}
  };
};

const makeResponse = ({
  ok = true,
  status = 200,
  url,
  text = "",
  contentType = "video/mp4",
  chunks = []
}) => ({
  ok,
  status,
  url,
  redirected: false,
  text: async () => text,
  headers: { get: (name) => (name === "content-type" ? contentType : "") },
  body: { getReader: () => makeReader(chunks) }
});

test("直播探测：播放列表两步流程测出分片吞吐", async () => {
  const playlistText = [
    "#EXTM3U",
    '#EXT-X-MAP:URI="init.m4s"',
    "#EXTINF:1.00,x",
    "seg1.m4s",
    "#EXTINF:1.00,x",
    "seg2.m4s"
  ].join("\n");
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    if (String(url).includes("index.m3u8")) {
      return makeResponse({ url: String(url), text: playlistText });
    }
    return makeResponse({
      url: String(url),
      chunks: [new Uint8Array(64 * 1024), new Uint8Array(64 * 1024)]
    });
  };
  const result = await testLiveCandidate(
    {
      host: "d1--ov-gotcha207.bilivideo.com",
      kind: "live",
      url: PLAYLIST_207,
      playlist: true,
      direct: true,
      maxBytes: 128 * 1024,
      timeoutMs: 5000,
      stage: "quick"
    },
    { fetchImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 128 * 1024);
  assert.equal(result.kind, "live");
  assert.ok(result.mbps > 0);
  assert.match(fetched[1], /seg2\.m4s$/, "取最新分片");
});

test("直播探测：中继变体列表与 HTTP 错误都判为不可用", async () => {
  const relayText = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:PROGRAM-ID=1",
    "https://relay.example.com/x.m3u8"
  ].join("\n");
  const relay = await testLiveCandidate(
    {
      host: "d1--ov-gotcha207.bilivideo.com",
      kind: "live",
      url: PLAYLIST_207,
      playlist: true,
      maxBytes: 1024,
      timeoutMs: 5000,
      stage: "quick"
    },
    {
      fetchImpl: async (url) =>
        makeResponse({ url: String(url), text: relayText })
    }
  );
  assert.equal(relay.ok, false);
  assert.equal(relay.error, "播放列表没有同源分片");

  const denied = await testLiveCandidate(
    {
      host: "d1--ov-gotcha05.bilivideo.com",
      kind: "live",
      url: FLV_05,
      playlist: false,
      maxBytes: 1024,
      timeoutMs: 5000,
      stage: "quick"
    },
    {
      fetchImpl: async (url) =>
        makeResponse({ ok: false, status: 403, url: String(url) })
    }
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "HTTP 403");
});

test("直播探测：FLV 直接读流并在样本上限截断", async () => {
  const result = await testLiveCandidate(
    {
      host: "d1--ov-gotcha07.bilivideo.com",
      kind: "live",
      url: FLV_07,
      playlist: false,
      maxBytes: 64 * 1024,
      timeoutMs: 5000,
      stage: "sustained"
    },
    {
      fetchImpl: async (url) =>
        makeResponse({
          url: String(url),
          contentType: "video/x-flv",
          chunks: [new Uint8Array(48 * 1024), new Uint8Array(48 * 1024)]
        })
    }
  );
  assert.equal(result.ok, true);
  assert.ok(result.bytes >= 64 * 1024);
  assert.equal(result.rangeAccepted, false);
});
