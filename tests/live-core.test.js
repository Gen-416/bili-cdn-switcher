import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveBenchmarkSpec,
  buildLiveProtocolRule,
  buildLiveRedirectRules,
  isLivePlaylistUrl,
  latestLiveSegmentUrl,
  liveCandidateHosts,
  liveClusterPrefix,
  liveFamilyUrl,
  livePlayurlUrls,
  liveStreamKey,
  mediaKindFromUrl
} from "../src/live-core.js";

const FLV_07 =
  "https://d1--ov-gotcha07.bilivideo.com/live-bvc/864118/live_x_y.flv?" +
  "expires=1&trid=a&sigparams=cdn&cdn=ov-gotcha07&sign=abc";
const FLV_07B =
  "https://d1--ov-gotcha07b.bilivideo.com/live-bvc/864118/live_x_y.flv?" +
  "expires=1&trid=a&sigparams=cdn&cdn=ov-gotcha07&sign=abc";
const FLV_05 =
  "https://d1--ov-gotcha05.bilivideo.com/live-bvc/504451/live_x_y.flv?" +
  "expires=2&trid=b&sigparams=cdn&cdn=ov-gotcha05&sign=def";
const PLAYLIST_207 =
  "https://d1--ov-gotcha207.bilivideo.com/live-bvc/551288/live_x_y/index.m3u8?expires=1";

test("按路径区分直播与点播媒体", () => {
  assert.equal(mediaKindFromUrl(FLV_07), "live");
  assert.equal(
    mediaKindFromUrl("https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.m4s"),
    "vod"
  );
  assert.equal(isLivePlaylistUrl(PLAYLIST_207), true);
  assert.equal(isLivePlaylistUrl(FLV_07), false);
});

test("直播流族优先播放列表，其次直播样本", () => {
  assert.equal(
    liveFamilyUrl({ livePlaylistUrl: PLAYLIST_207, sampleUrl: FLV_07 }),
    PLAYLIST_207
  );
  assert.equal(liveFamilyUrl({ sampleUrl: FLV_07 }), FLV_07);
  assert.equal(
    liveFamilyUrl({
      sampleUrl: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.m4s"
    }),
    ""
  );
  assert.equal(liveFamilyUrl({}), "");
});

test("按集群前缀之外的流名识别同一路流", () => {
  assert.equal(liveStreamKey(FLV_07), "live_x_y.flv");
  assert.equal(liveStreamKey(FLV_05), "live_x_y.flv");
  assert.equal(liveStreamKey(PLAYLIST_207), "live_x_y/index.m3u8");
  assert.equal(liveStreamKey("https://a.bilivideo.com/upgcxcode/a.m4s"), "");
  assert.equal(liveClusterPrefix(FLV_07), "/live-bvc/864118/");
  assert.equal(liveClusterPrefix(FLV_05), "/live-bvc/504451/");
});

test("直播候选保留同一路流的全部集群签发地址", () => {
  const pool = [FLV_07, FLV_07B, FLV_05, PLAYLIST_207];
  assert.deepEqual(livePlayurlUrls(pool, FLV_07), [FLV_07, FLV_07B, FLV_05]);
  assert.deepEqual(livePlayurlUrls(pool, PLAYLIST_207), [PLAYLIST_207]);
  assert.deepEqual(livePlayurlUrls(pool, ""), []);
  assert.deepEqual(liveCandidateHosts(pool, FLV_07), [
    "d1--ov-gotcha07.bilivideo.com",
    "d1--ov-gotcha07b.bilivideo.com",
    "d1--ov-gotcha05.bilivideo.com"
  ]);
});

test("跨集群切换生成入口重定向与前缀映射双规则", () => {
  const familyUrls = [FLV_07, FLV_07B, FLV_05];
  const rules = buildLiveRedirectRules({
    tabId: 42,
    ruleIds: [1000000042, 1100000042, 1200000042],
    targetUrl: FLV_05,
    familyUrls
  });
  assert.equal(rules.length, 2);
  const [entryRule, prefixRule] = rules;
  assert.equal(entryRule.priority, 2);
  assert.equal(entryRule.action.redirect.url, FLV_05);
  assert.match(
    entryRule.condition.regexFilter,
    /864118\/live_x_y\\\.flv/
  );
  assert.deepEqual(entryRule.condition.tabIds, [42]);
  assert.equal(prefixRule.priority, 1);
  assert.equal(
    prefixRule.action.redirect.regexSubstitution,
    "https://d1--ov-gotcha05.bilivideo.com/live-bvc/504451/\\1"
  );
  assert.match(prefixRule.condition.regexFilter, /864118/);
});

test("FLV 优先规则只改写播放接口请求的 protocol 参数", () => {
  const rule = buildLiveProtocolRule({ id: 900000 });
  assert.equal(rule.action.type, "redirect");
  assert.deepEqual(
    rule.action.redirect.transform.queryTransform.addOrReplaceParams,
    [{ key: "protocol", value: "0" }]
  );
  assert.equal("url" in rule.action.redirect, false);
  assert.deepEqual(rule.condition.initiatorDomains, ["bilibili.com"]);
  assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest"]);
  assert.match(rule.condition.regexFilter, /getRoomPlayInfo/);
  assert.match(rule.condition.regexFilter, /getInfoByRoom/);
  assert.match(rule.condition.regexFilter, /api\\\.live\\\.bilibili\\\.com/);
});

test("同集群兄弟节点不需要跨集群规则", () => {
  const rules = buildLiveRedirectRules({
    tabId: 42,
    ruleIds: [1000000042, 1100000042, 1200000042],
    targetUrl: FLV_07B,
    familyUrls: [FLV_07, FLV_07B]
  });
  assert.deepEqual(rules, []);
});

test("直播探测优先使用主机自己的签发 URL，换 host 仅兜底", () => {
  const pool = [FLV_07, FLV_05];
  const direct = buildLiveBenchmarkSpec({
    familyUrl: FLV_07,
    playurlUrls: pool,
    host: "d1--ov-gotcha05.bilivideo.com",
    maxBytes: 1,
    timeoutMs: 1000,
    stage: "quick"
  });
  assert.equal(direct.url, FLV_05);
  assert.equal(direct.direct, true);
  assert.equal(direct.kind, "live");
  assert.equal(direct.playlist, false);

  const swapped = buildLiveBenchmarkSpec({
    familyUrl: FLV_07,
    playurlUrls: pool,
    host: "d1--ov-gotcha07b.bilivideo.com",
    maxBytes: 1,
    timeoutMs: 1000,
    stage: "quick"
  });
  assert.equal(swapped.url, FLV_07B);
  assert.equal(swapped.direct, false);
});

test("从直播播放列表解析最新的同源分片", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    '#EXT-X-MAP:URI="h1787063138.m4s"',
    "#EXTINF:1.00,info",
    "1787063139.m4s",
    "#EXTINF:1.00,info",
    "1787063140.m4s"
  ].join("\n");
  assert.equal(
    latestLiveSegmentUrl(playlist, PLAYLIST_207),
    "https://d1--ov-gotcha207.bilivideo.com/live-bvc/551288/live_x_y/1787063140.m4s"
  );
  assert.equal(
    latestLiveSegmentUrl("#EXTM3U\n" + '#EXT-X-MAP:URI="init.m4s"', PLAYLIST_207),
    "https://d1--ov-gotcha207.bilivideo.com/live-bvc/551288/live_x_y/init.m4s"
  );
  const relayVariant = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1280000",
    "https://relay.example.com/d1--ov-gotcha07.bilivideo.com/live_x.m3u8?x=1"
  ].join("\n");
  assert.equal(latestLiveSegmentUrl(relayVariant, PLAYLIST_207), "");
  assert.equal(latestLiveSegmentUrl("not a playlist", PLAYLIST_207), "");
});
