// 直播编排层：把 service worker 里的直播控制流收拢到一个模块。
// 与 live-core.js（纯策略函数）的分工：这里负责观测状态机、候选组装、
// 规则选择和探测执行；所有副作用（fetch、页面消息、规则接口）通过参数
// 注入，因此整层可以在 Node 里做行为级测试，不需要 chrome mock 框架。
import { isLivePlaybackUrl, isSupportedMediaUrl, uniqueCandidates } from "./core.js";
import {
  buildLiveProtocolRule,
  buildLiveRedirectRules,
  isLivePlaylistUrl,
  latestLiveSegmentUrl,
  liveCandidateHosts,
  liveFamilyUrl,
  livePlayurlUrls,
  liveStreamKey,
  mediaKindFromUrl
} from "./live-core.js";

const DEFAULT_LIVE_SAMPLE_BYTES = 128 * 1024;
const MAX_LIVE_SAMPLE_BYTES = 1024 * 1024;
const DEFAULT_LIVE_TIMEOUT_MS = 5000;
const MIN_LIVE_TIMEOUT_MS = 1000;
const MAX_LIVE_TIMEOUT_MS = 9000;

export function isLiveTab(state) {
  return isLivePlaybackUrl(state?.pageUrl || "");
}

// 换流（key 变化）后选择结果失效，但观测继续沿用。
export function resetLiveSelection(state) {
  state.autoHost = "";
  state.autoAttempted = false;
  state.benchmarks = [];
  state.stalledHosts = [];
}

// 协议切换等硬重置：连观测一起清空，等播放器重连后重新发现。
export function resetLiveObservation(state) {
  resetLiveSelection(state);
  state.observedHost = "";
  state.sampleUrl = "";
  state.sampleRange = "";
  state.livePlaylistUrl = "";
  state.playurlUrls = [];
  state.playurlVideoUrls = [];
  state.nextAutoRefreshCheckAt = 0;
}

// 就地更新直播观测状态，返回是否发生了换流。
// 流名（key）变化意味着播放器拿到了新的流（重连换清晰度或重新推流）；
// 同流换集群（前缀变化）不算换流。只有播放列表和 FLV 能当流族锚点：
// HLS 分段秒级轮换且必然伴随播放列表出现，用分段锚定会让测速落在
// 转瞬过期的路径上。
export function applyLiveObservation(state, url) {
  state.observedHost = url.hostname;
  if (isLivePlaylistUrl(url.href)) {
    const familyChanged =
      Boolean(state.livePlaylistUrl) &&
      liveStreamKey(state.livePlaylistUrl) !== liveStreamKey(url.href);
    state.livePlaylistUrl = url.href;
    if (familyChanged) resetLiveSelection(state);
    return { familyChanged };
  }
  if (
    /\.flv(?:$|[?#])/i.test(url.pathname) &&
    (!state.sampleUrl || mediaKindFromUrl(state.sampleUrl) === "live")
  ) {
    state.sampleUrl = url.href;
  }
  return { familyChanged: false };
}

// 直播候选：只用当前流签发的同族节点和用户自定义项，
// 不使用内置种子和学习记录（对直播路径必然失败）。
export function liveCandidatesFor(config, state) {
  const family = liveFamilyUrl(state);
  const observedCandidate =
    state.observedHost && family ? state.observedHost : "";
  return uniqueCandidates(
    [],
    config.customHosts,
    observedCandidate,
    liveCandidateHosts(state.playurlUrls, family),
    [],
    config.disabledHosts
  );
}

// 选择直播切换规则：目标在不同集群（路径前缀不同）时返回入口重定向 +
// 前缀映射双规则；返回空数组表示应退回单纯的 host 替换规则
// （同集群兄弟，或目标没有签发 URL 可用）。
export function chooseLiveRules({ tabId, ruleIds, state, targetHost }) {
  const familyUrl = liveFamilyUrl(state);
  const familyUrls = [
    familyUrl,
    ...livePlayurlUrls(state.playurlUrls, familyUrl)
  ];
  const targetUrl = familyUrls
    .slice(1)
    .find((value) => new URL(value).hostname === targetHost);
  if (!targetUrl) return [];
  return buildLiveRedirectRules({ tabId, ruleIds, targetUrl, familyUrls });
}

// 向页面播放器查询它正在播放的流地址，返回通过白名单校验的直播 URL 或空串。
export async function queryLivePlayerUrl(tabId, sendMessage) {
  try {
    const response = await sendMessage(tabId, {
      type: "GET_LIVE_PLAYER_URL"
    });
    const url = response?.ok ? response.url : "";
    return url && isSupportedMediaUrl(url) && mediaKindFromUrl(url) === "live"
      ? url
      : "";
  } catch {
    return "";
  }
}

// 按配置增删 FLV 优先的播放接口参数改写规则。
export async function syncLiveProtocolRule({
  preference,
  ruleId,
  updateSessionRules
}) {
  if (preference === "flv") {
    await updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [buildLiveProtocolRule({ id: ruleId })]
    });
    return;
  }
  await updateSessionRules({ removeRuleIds: [ruleId] });
}

// 直播流不依赖 Range：HLS 先取播放列表再拉最新分片，FLV 直接读流并截断。
export async function testLiveCandidate(spec, { fetchImpl = fetch } = {}) {
  const { host, url: entryUrl } = spec;
  const maxBytes = Math.min(
    Math.max(Number(spec.maxBytes) || DEFAULT_LIVE_SAMPLE_BYTES, 1),
    MAX_LIVE_SAMPLE_BYTES
  );
  const timeoutMs = Math.min(
    Math.max(Number(spec.timeoutMs) || DEFAULT_LIVE_TIMEOUT_MS, MIN_LIVE_TIMEOUT_MS),
    MAX_LIVE_TIMEOUT_MS
  );
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    let mediaUrl = entryUrl;
    let ttfbMs = 0;
    if (spec.playlist) {
      response = await fetchImpl(entryUrl, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal
      });
      ttfbMs = performance.now() - startedAt;
      if (!response.ok) {
        return {
          host,
          ok: false,
          status: response.status,
          error: `HTTP ${response.status}`,
          ttfbMs: Math.round(ttfbMs),
          stage: spec.stage
        };
      }
      const playlistText = await response.text();
      // 某些节点会返回指向第三方中继域名的变体列表，视为不可用。
      mediaUrl = latestLiveSegmentUrl(playlistText, response.url);
      if (!mediaUrl || new URL(mediaUrl).hostname !== host) {
        return {
          host,
          ok: false,
          status: response.status,
          error: "播放列表没有同源分片",
          ttfbMs: Math.round(ttfbMs),
          stage: spec.stage
        };
      }
    }

    const mediaStartedAt = performance.now();
    response = await fetchImpl(mediaUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
    if (!spec.playlist) ttfbMs = performance.now() - startedAt;
    if (!response.ok) {
      return {
        host,
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        ttfbMs: Math.round(ttfbMs),
        stage: spec.stage
      };
    }
    const contentType = response.headers.get("content-type") || "";
    if (/text\/html|application\/json/i.test(contentType)) {
      return {
        host,
        ok: false,
        status: response.status,
        error: "返回内容不是媒体",
        ttfbMs: Math.round(ttfbMs),
        stage: spec.stage
      };
    }

    const reader = response.body?.getReader();
    let bytes = 0;
    if (reader) {
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
      }
      await reader.cancel();
    } else {
      const buffer = await response.arrayBuffer();
      bytes = Math.min(buffer.byteLength, maxBytes);
    }

    const durationMs = Math.max(performance.now() - mediaStartedAt, 1);
    return {
      host,
      ok: bytes > 0,
      status: response.status,
      bytes,
      ttfbMs: Math.round(ttfbMs),
      durationMs: Math.round(durationMs),
      mbps: Number(((bytes * 8) / durationMs / 1000).toFixed(2)),
      redirected: response.redirected,
      finalHost: new URL(response.url).hostname,
      source: spec.direct ? "playurl" : "host-swap",
      stage: spec.stage,
      rangeAccepted: false,
      contentType,
      kind: "live"
    };
  } catch (error) {
    return {
      host,
      ok: false,
      status: response?.status || 0,
      error:
        error?.name === "AbortError" ? "超时" : error?.message || "测速失败",
      ttfbMs: Math.round(performance.now() - startedAt),
      stage: spec.stage
    };
  } finally {
    clearTimeout(timer);
  }
}
