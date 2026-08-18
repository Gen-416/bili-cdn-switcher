import { BUILTIN_CANDIDATES } from "./candidates.js";
import {
  AUTO_REFRESH_PROFILES,
  buildSessionRedirectRule,
  classifyAutoResultAge,
  chooseAutoBenchmark,
  chooseBenchmarkCandidates,
  isAutoRefreshActivityEligible,
  isBilibiliInitiator,
  isCandidateMediaUrl,
  isLivePlaybackUrl,
  isPlaybackUrl,
  isSupportedMediaUrl,
  makeProbeRange,
  normalizeCdnHosts,
  planStallRecovery,
  playbackPageKey,
  replaceMediaHost,
  retainRecentStalledHosts,
  resolveAutoRefreshProfile,
  sameMediaPath,
  selectRecoveryBenchmark,
  shouldReleaseExpiredAutoRule,
  uniqueCandidates,
  validateCdnHost
} from "./core.js";
import {
  buildLiveBenchmarkSpec,
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

const CONFIG_KEY = "config";
const HOST_HEALTH_KEY = "hostHealth";
const RULE_ID_OFFSET = 1_000_000;
const LIVE_PROTOCOL_RULE_ID = 900_000;
const QUICK_SAMPLE_BYTES = 128 * 1024;
const SUSTAINED_SAMPLE_BYTES = 1024 * 1024;
const QUICK_TEST_TIMEOUT_MS = 5000;
const SUSTAINED_TEST_TIMEOUT_MS = 9000;
const SUSTAINED_FINALISTS = 3;
const BENCHMARK_SCHEMA = 3;
const MAX_EVENTS = 24;
const MAX_PLAYURL_URLS = 80;
const MAX_LEARNED_HOSTS = 24;
const MAX_BENCHMARK_HOSTS = 8;
const RECENT_STALL_HOST_LIMIT = 3;
const HOST_HEALTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_ACTIVITY_RETRY_MS = 30 * 1000;
const AUTO_FAILURE_RETRY_MS = 5 * 60 * 1000;
const MIN_RECOVERY_SWITCH_INTERVAL_MS = 7 * 1000;
const tabStates = new Map();
let autoRefreshOwnerTabId = null;

function extensionVersion() {
  const manifest = chrome.runtime.getManifest();
  return manifest.version_name || manifest.version;
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: "auto",
  manualHost: BUILTIN_CANDIDATES[0].host,
  customHosts: [],
  disabledHosts: [],
  autoBestHost: "",
  autoBestAt: 0,
  autoBestSchema: 0,
  autoRefreshProfile: "balanced",
  liveProtocolPreference: "auto"
});

function stateFor(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      playback: false,
      pageUrl: "",
      pageKey: "",
      contentVersion: "",
      observedHost: "",
      sampleUrl: "",
      sampleRange: "",
      videoSampleUrl: "",
      videoSampleRange: "",
      livePlaylistUrl: "",
      playurlUrls: [],
      playurlVideoUrls: [],
      autoHost: "",
      benchmarkRunning: false,
      benchmarkPhase: "",
      autoAttempted: false,
      autoRefreshChecking: false,
      nextAutoRefreshCheckAt: 0,
      benchmarks: [],
      stalledHosts: [],
      recoveryCount: 0,
      recoveryInFlight: false,
      lastRecovery: null,
      events: []
    });
  }
  return tabStates.get(tabId);
}

function appendEvent(tabId, event) {
  const state = stateFor(tabId);
  state.events.unshift({ at: Date.now(), ...event });
  state.events = state.events.slice(0, MAX_EVENTS);
}

async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const config = { ...DEFAULT_CONFIG, ...(stored[CONFIG_KEY] || {}) };
  return {
    ...config,
    customHosts: normalizeCdnHosts(config.customHosts),
    disabledHosts: normalizeCdnHosts(config.disabledHosts),
    autoRefreshProfile: resolveAutoRefreshProfile(
      config.autoRefreshProfile
    ).id,
    liveProtocolPreference:
      config.liveProtocolPreference === "flv" ? "flv" : "auto"
  };
}

async function saveConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

function freshAutoHost(config) {
  const validation = validateCdnHost(config.autoBestHost || "");
  const disabled = new Set(config.disabledHosts || []);
  const policy = resolveAutoRefreshProfile(config.autoRefreshProfile);
  return (
    validation.ok &&
    !disabled.has(validation.host) &&
    config.autoBestSchema === BENCHMARK_SCHEMA &&
    Number.isFinite(config.autoBestAt) &&
    Date.now() - config.autoBestAt < policy.hardTtlMs
  )
    ? validation.host
    : "";
}

function autoResultStatus(config) {
  const validation = validateCdnHost(config.autoBestHost || "");
  const disabled = new Set(config.disabledHosts || []);
  if (
    !validation.ok ||
    disabled.has(validation.host) ||
    config.autoBestSchema !== BENCHMARK_SCHEMA
  ) {
    return "expired";
  }
  const policy = resolveAutoRefreshProfile(config.autoRefreshProfile);
  return classifyAutoResultAge(config.autoBestAt, {
    softTtlMs: policy.softTtlMs,
    hardTtlMs: policy.hardTtlMs
  });
}

function sanitizeHealth(raw) {
  const now = Date.now();
  const entries = Object.entries(raw && typeof raw === "object" ? raw : {})
    .filter(([host, item]) => {
      const validation = validateCdnHost(host);
      return (
        validation.ok &&
        item &&
        typeof item === "object" &&
        Number.isFinite(item.lastSeenAt) &&
        now - item.lastSeenAt < HOST_HEALTH_TTL_MS
      );
    })
    .sort((a, b) => {
      const aItem = a[1];
      const bItem = b[1];
      const aHealthy = (aItem.successes || 0) > 0;
      const bHealthy = (bItem.successes || 0) > 0;
      if (aHealthy !== bHealthy) return aHealthy ? -1 : 1;
      return (bItem.lastSeenAt || 0) - (aItem.lastSeenAt || 0);
    })
    .slice(0, MAX_LEARNED_HOSTS);
  return Object.fromEntries(entries);
}

async function getHostHealth() {
  const stored = await chrome.storage.local.get(HOST_HEALTH_KEY);
  return sanitizeHealth(stored[HOST_HEALTH_KEY]);
}

async function rememberHosts(hosts) {
  if (!Array.isArray(hosts) || !hosts.length) return;
  const health = await getHostHealth();
  const now = Date.now();
  for (const rawHost of hosts) {
    const validation = validateCdnHost(rawHost);
    if (!validation.ok) continue;
    health[validation.host] = {
      successes: 0,
      failures: 0,
      ...(health[validation.host] || {}),
      lastSeenAt: now
    };
  }
  await chrome.storage.local.set({
    [HOST_HEALTH_KEY]: sanitizeHealth(health)
  });
}

async function saveBenchmarkHealth(results) {
  const health = await getHostHealth();
  const now = Date.now();
  for (const result of results) {
    const validation = validateCdnHost(result?.host || "");
    if (!validation.ok) continue;
    const old = health[validation.host] || {
      successes: 0,
      failures: 0
    };
    const next = {
      ...old,
      lastSeenAt: now,
      lastTestedAt: now
    };
    if (result.ok) {
      next.successes = (old.successes || 0) + 1;
      next.mbps = Number.isFinite(old.mbps)
        ? Number((old.mbps * 0.6 + result.mbps * 0.4).toFixed(2))
        : result.mbps;
      next.ttfbMs = Number.isFinite(old.ttfbMs)
        ? Math.round(old.ttfbMs * 0.6 + result.ttfbMs * 0.4)
        : result.ttfbMs;
      next.lastStage = result.stage || "sustained";
    } else {
      next.failures = (old.failures || 0) + 1;
    }
    health[validation.host] = next;
  }
  await chrome.storage.local.set({
    [HOST_HEALTH_KEY]: sanitizeHealth(health)
  });
}

async function rememberPlaybackFailure(host) {
  const validation = validateCdnHost(host || "");
  if (!validation.ok) return;
  const health = await getHostHealth();
  const old = health[validation.host] || {
    successes: 0,
    failures: 0
  };
  health[validation.host] = {
    ...old,
    failures: (old.failures || 0) + 1,
    playbackFailures: (old.playbackFailures || 0) + 1,
    lastFailureAt: Date.now(),
    lastSeenAt: Date.now()
  };
  await chrome.storage.local.set({
    [HOST_HEALTH_KEY]: sanitizeHealth(health)
  });
}

function learnedCandidates(health) {
  return Object.entries(health)
    .filter(([, item]) => {
      const successes = item.successes || 0;
      const failures = item.failures || 0;
      return successes > 0 || failures < 3;
    })
    .sort((a, b) => {
      const aItem = a[1];
      const bItem = b[1];
      const aRatio =
        (aItem.successes || 0) /
        Math.max((aItem.successes || 0) + (aItem.failures || 0), 1);
      const bRatio =
        (bItem.successes || 0) /
        Math.max((bItem.successes || 0) + (bItem.failures || 0), 1);
      return (
        bRatio - aRatio ||
        (bItem.mbps || 0) - (aItem.mbps || 0) ||
        (bItem.lastSeenAt || 0) - (aItem.lastSeenAt || 0)
      );
    })
    .map(([host, item]) => ({
      host,
      label: host,
      note: Number.isFinite(item.mbps)
        ? `近期成功，约 ${item.mbps} Mbps；真实卡顿 ${item.playbackFailures || 0} 次`
        : "近期播放中出现"
    }));
}

function playurlHosts(state) {
  return [
    ...new Set(
      state.playurlUrls
        .filter(isCandidateMediaUrl)
        .map((value) => new URL(value).hostname)
    )
  ];
}

function isLiveTab(state) {
  return isLivePlaybackUrl(state.pageUrl);
}

async function candidatesFor(config, state) {
  if (isLiveTab(state)) {
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
  const health = await getHostHealth();
  const observedCandidate =
    state.sampleUrl && isCandidateMediaUrl(state.sampleUrl)
      ? state.observedHost
      : "";
  return uniqueCandidates(
    BUILTIN_CANDIDATES,
    config.customHosts,
    observedCandidate,
    playurlHosts(state),
    learnedCandidates(health),
    config.disabledHosts
  );
}

function ruleIdForTab(tabId) {
  const id = RULE_ID_OFFSET + tabId;
  if (id > 2_147_483_647) throw new RangeError("标签页 ID 超出规则范围");
  return id;
}

// 直播跨集群切换最多需要三条附加规则（入口重定向 + 两个旧集群前缀映射）。
const LIVE_RULE_ID_OFFSETS = [
  1_000_000_000, 1_100_000_000, 1_200_000_000
];

function liveRuleIdsForTab(tabId) {
  return LIVE_RULE_ID_OFFSETS.map((offset) => {
    const id = offset + tabId;
    if (id > 2_147_483_647) throw new RangeError("标签页 ID 超出规则范围");
    return id;
  });
}

function allRuleIdsForTab(tabId) {
  return [ruleIdForTab(tabId), ...liveRuleIdsForTab(tabId)];
}

function activeRuleTarget(rules, tabId) {
  const ids = new Set(allRuleIdsForTab(tabId));
  for (const rule of rules) {
    if (!ids.has(rule.id)) continue;
    const redirect = rule.action?.redirect || {};
    try {
      if (redirect.transform?.host) return redirect.transform.host;
      if (redirect.url) return new URL(redirect.url).hostname;
      if (redirect.regexSubstitution) {
        return new URL(redirect.regexSubstitution.replace(/\\1$/, "")).hostname;
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function removeRule(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: allRuleIdsForTab(tabId)
  });
  try {
    await setBadge(tabId, false);
  } catch {
    // The tab may already have been closed.
  }
}

async function setBadge(tabId, enabled, mode = "") {
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: enabled ? "#00a1d6" : "#777777"
  });
  await chrome.action.setBadgeText({
    tabId,
    text: enabled ? (mode === "auto" ? "A" : "ON") : ""
  });
}

async function applyRule(tabId) {
  const config = await getConfig();
  const state = stateFor(tabId);
  const targetHost =
    config.mode === "auto" ? state.autoHost : config.manualHost;
  const validation = validateCdnHost(targetHost || "");
  const disabled = new Set(config.disabledHosts || []);
  let shouldEnable =
    config.enabled &&
    state.playback &&
    isPlaybackUrl(state.pageUrl) &&
    validation.ok &&
    !disabled.has(validation.host);

  // 直播手动模式下，跨流沿用的 host（多半是点播 UPOS 或过期集群）
  // 无法服务当前直播路径，只放行当前流签发、实际观测或用户自定义的节点。
  if (shouldEnable && config.mode === "manual" && isLiveTab(state)) {
    const allowed = new Set([
      state.observedHost,
      ...liveCandidateHosts(state.playurlUrls, liveFamilyUrl(state)),
      ...config.customHosts
    ]);
    shouldEnable = allowed.has(validation.host);
  }

  if (!shouldEnable) {
    await removeRule(tabId);
    return "";
  }

  let rules = [];
  if (isLiveTab(state)) {
    // 目标在不同集群（路径前缀不同）时用入口重定向 + 前缀映射双规则，
    // 目标是同集群兄弟（路径相同）时退回单纯 host 替换。
    const familyUrl = liveFamilyUrl(state);
    const familyUrls = [familyUrl, ...livePlayurlUrls(state.playurlUrls, familyUrl)];
    const targetUrl = familyUrls
      .slice(1)
      .find((value) => new URL(value).hostname === validation.host);
    if (targetUrl) {
      rules = buildLiveRedirectRules({
        tabId,
        ruleIds: liveRuleIdsForTab(tabId),
        targetUrl,
        familyUrls
      });
    }
  }
  if (!rules.length) {
    rules = [
      buildSessionRedirectRule({
        id: ruleIdForTab(tabId),
        tabId,
        targetHost: validation.host,
        liveOnly: isLiveTab(state)
      })
    ];
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: allRuleIdsForTab(tabId),
    addRules: rules
  });
  await setBadge(tabId, true, config.mode);
  return validation.host;
}

async function applyToKnownPlaybackTabs() {
  const config = await getConfig();
  const tabs = await chrome.tabs.query({
    url: [
      "https://www.bilibili.com/video/*",
      "https://www.bilibili.com/bangumi/play/*",
      "https://www.bilibili.com/cheese/play/*",
      "https://m.bilibili.com/video/*",
      "https://m.bilibili.com/bangumi/play/*",
      "https://live.bilibili.com/*"
    ]
  });
  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map(async (tab) => {
        const state = stateFor(tab.id);
        state.pageUrl = tab.url || "";
        state.playback = isPlaybackUrl(state.pageUrl);
        state.pageKey = playbackPageKey(state.pageUrl);
        const cachedHost = freshAutoHost(config);
        if (config.mode === "auto" && cachedHost && !isLiveTab(state)) {
          state.autoHost = cachedHost;
        }
        await applyRule(tab.id);
        await pushDiagnostics(tab.id);
      })
  );
}

function updatePageState(tabId, pageUrl) {
  const state = stateFor(tabId);
  const normalizedUrl = pageUrl || "";
  const nextPageKey = playbackPageKey(normalizedUrl);
  const changed = Boolean(state.pageKey && state.pageKey !== nextPageKey);
  state.pageUrl = normalizedUrl;
  state.pageKey = nextPageKey;
  state.playback = isPlaybackUrl(normalizedUrl);

  if (changed) {
    state.observedHost = "";
    state.sampleUrl = "";
    state.sampleRange = "";
    state.videoSampleUrl = "";
    state.videoSampleRange = "";
    state.livePlaylistUrl = "";
    state.playurlUrls = [];
    state.playurlVideoUrls = [];
    state.autoHost = "";
    state.autoAttempted = false;
    state.autoRefreshChecking = false;
    state.nextAutoRefreshCheckAt = 0;
    state.benchmarkPhase = "";
    state.benchmarks = [];
    state.stalledHosts = [];
    state.recoveryCount = 0;
    state.lastRecovery = null;
    state.events = [];
  }
  return state;
}

function observePlayurlUrls(tabId, values, videoValues = []) {
  if (tabId < 0 || !Array.isArray(values)) return [];
  const state = stateFor(tabId);
  const urls = values
    .filter((value) => typeof value === "string" && isSupportedMediaUrl(value))
    .map((value) => new URL(value).href);
  if (!urls.length) return [];

  state.playurlUrls = [
    ...new Set([...urls, ...state.playurlUrls])
  ].slice(0, MAX_PLAYURL_URLS);
  const videoUrls = (Array.isArray(videoValues) ? videoValues : [])
    .filter((value) => typeof value === "string" && isSupportedMediaUrl(value))
    .map((value) => new URL(value).href);
  state.playurlVideoUrls = [
    ...new Set([...videoUrls, ...state.playurlVideoUrls])
  ].slice(0, MAX_PLAYURL_URLS);
  if (
    !state.videoSampleUrl &&
    state.sampleUrl &&
    state.playurlVideoUrls.some((value) =>
      sameMediaPath(value, state.sampleUrl)
    )
  ) {
    state.videoSampleUrl = state.sampleUrl;
    state.videoSampleRange = state.sampleRange;
  }
  const hosts = playurlHosts(state);
  appendEvent(tabId, {
    kind: "playurl",
    count: urls.length,
    hosts: hosts.length
  });
  void rememberHosts(hosts);
  return hosts;
}

function observeLiveMedia(tabId, state, url, source, { autorun = true } = {}) {
  state.observedHost = url.hostname;
  if (isLivePlaylistUrl(url.href)) {
    // 流名（key）变化意味着播放器拿到了新的流（重连换清晰度或重新推流），
    // 旧流的测速结果与规则全部失效；同流换集群（前缀变化）不算换流。
    const familyChanged =
      state.livePlaylistUrl &&
      liveStreamKey(state.livePlaylistUrl) !== liveStreamKey(url.href);
    state.livePlaylistUrl = url.href;
    if (familyChanged) {
      state.autoHost = "";
      state.autoAttempted = false;
      state.benchmarks = [];
      state.stalledHosts = [];
      appendEvent(tabId, { kind: "live-family-changed", host: url.hostname });
      void removeRule(tabId);
    }
  } else if (
    !state.sampleUrl ||
    mediaKindFromUrl(state.sampleUrl) === "live"
  ) {
    state.sampleUrl = url.href;
  }
  appendEvent(tabId, { kind: source, host: url.hostname, live: true });
  if (autorun) void maybeRunAuto(tabId);
}

// FLV 是一条长连接，整场直播只在建连时产生一次 webRequest 事件；
// service worker 空闲重启后观测状态清零且不会再有新事件。此时向页面
// 播放器查询它正在播放的流地址，直接重建流族与观测 host。
async function ensureLiveFamily(tabId, state) {
  if (!isLiveTab(state) || liveFamilyUrl(state)) return;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_LIVE_PLAYER_URL"
    });
    const url = response?.ok ? response.url : "";
    if (
      url &&
      isSupportedMediaUrl(url) &&
      mediaKindFromUrl(url) === "live"
    ) {
      observeLiveMedia(tabId, state, new URL(url), "player", {
        autorun: false
      });
    }
  } catch {
    // 页面桥不可用时，等待下一次媒体请求自然重建。
  }
}

function observeMedia(tabId, value, source = "request", rangeHeader = "") {
  if (tabId < 0 || !isSupportedMediaUrl(value)) return;
  const state = stateFor(tabId);
  const url = new URL(value);
  if (mediaKindFromUrl(url.href) === "live") {
    observeLiveMedia(tabId, state, url, source);
    return;
  }
  state.observedHost = url.hostname;
  const isVideoSample = state.playurlVideoUrls.some((candidate) =>
    sameMediaPath(candidate, url.href)
  );
  if (
    isVideoSample ||
    !state.sampleUrl ||
    (!state.videoSampleUrl && /\.(m4s|mp4)(?:$|\?)/i.test(url.href))
  ) {
    state.sampleUrl = url.href;
  }
  const probeRange = makeProbeRange(rangeHeader, QUICK_SAMPLE_BYTES);
  if (probeRange && (isVideoSample || !state.videoSampleUrl)) {
    state.sampleRange = rangeHeader.trim();
  }
  if (isVideoSample) {
    state.videoSampleUrl = url.href;
    if (probeRange) state.videoSampleRange = rangeHeader.trim();
  }
  appendEvent(tabId, {
    kind: source,
    host: url.hostname,
    range: probeRange || ""
  });
  const activeSampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  if (activeSampleRange) void maybeRunAuto(tabId);
}

function benchmarkSpec(
  state,
  candidate,
  {
    maxBytes = QUICK_SAMPLE_BYTES,
    offsetBytes = 0,
    timeoutMs = QUICK_TEST_TIMEOUT_MS,
    stage = "quick"
  } = {}
) {
  const sampleUrl = state.videoSampleUrl || state.sampleUrl;
  const sampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  const sample = new URL(sampleUrl);
  const directPool = state.videoSampleUrl
    ? state.playurlVideoUrls
    : state.playurlUrls;
  const directUrls = directPool.filter(
    (value) =>
      isSupportedMediaUrl(value) &&
      new URL(value).hostname === candidate.host
  );
  const exact = directUrls.find(
    (value) => new URL(value).pathname === sample.pathname
  );
  const directUrl =
    exact || (state.videoSampleUrl ? "" : directUrls[0] || "");
  const baseRange =
    exact || !directUrl
      ? sampleRange || "bytes=0-"
      : "bytes=0-";
  return {
    host: candidate.host,
    url: directUrl || replaceMediaHost(sampleUrl, candidate.host),
    range:
      makeProbeRange(baseRange, maxBytes, offsetBytes) ||
      makeProbeRange("bytes=0-", maxBytes),
    direct: Boolean(directUrl),
    maxBytes,
    timeoutMs,
    stage
  };
}

// 直播流不依赖 Range：HLS 先取播放列表再拉最新分片，FLV 直接读流并截断。
async function testLiveCandidate(spec) {
  const { host, url: entryUrl } = spec;
  const maxBytes = Math.min(
    Math.max(Number(spec.maxBytes) || QUICK_SAMPLE_BYTES, 1),
    SUSTAINED_SAMPLE_BYTES
  );
  const timeoutMs = Math.min(
    Math.max(Number(spec.timeoutMs) || QUICK_TEST_TIMEOUT_MS, 1000),
    SUSTAINED_TEST_TIMEOUT_MS
  );
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    let mediaUrl = entryUrl;
    let ttfbMs = 0;
    if (spec.playlist) {
      response = await fetch(entryUrl, {
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
    response = await fetch(mediaUrl, {
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

async function testCandidate(spec) {
  if (spec.kind === "live") return testLiveCandidate(spec);
  const { host, url: testUrl, range: sampleRange } = spec;
  const maxBytes = Math.min(
    Math.max(Number(spec.maxBytes) || QUICK_SAMPLE_BYTES, 1),
    SUSTAINED_SAMPLE_BYTES
  );
  const timeoutMs = Math.min(
    Math.max(Number(spec.timeoutMs) || QUICK_TEST_TIMEOUT_MS, 1000),
    SUSTAINED_TEST_TIMEOUT_MS
  );
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(testUrl, {
      method: "GET",
      headers: { Range: sampleRange || `bytes=0-${maxBytes - 1}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
    const ttfbMs = performance.now() - startedAt;
    if (!response.ok) {
      return {
        host,
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        ttfbMs: Math.round(ttfbMs)
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

    const durationMs = Math.max(performance.now() - startedAt, 1);
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
      rangeAccepted: response.status === 206,
      contentType
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

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await task(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function testCandidatesInPage(tabId, specs, concurrency = 2) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "RUN_PAGE_BENCHMARK",
    specs,
    concurrency
  });
  if (!response?.ok || !Array.isArray(response.results)) {
    throw new Error(response?.error || "页面测速没有返回结果");
  }
  return response.results;
}

async function refreshPlayurlUrlsFromPage(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_PLAYURL_URLS"
    });
    if (response?.ok && Array.isArray(response.urls)) {
      observePlayurlUrls(tabId, response.urls, response.videoUrls);
    }
  } catch {
    // The page observer is optional; webRequest discovery remains available.
  }
}

async function syncLiveProtocolRule(config) {
  if (config.liveProtocolPreference === "flv") {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [LIVE_PROTOCOL_RULE_ID],
      addRules: [buildLiveProtocolRule({ id: LIVE_PROTOCOL_RULE_ID })]
    });
  } else {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [LIVE_PROTOCOL_RULE_ID]
    });
  }
}

// 协议切换后旧流的观测、成绩与规则全部作废，等播放器重连后重新发现。
async function resetLiveTab(tabId) {
  const state = stateFor(tabId);
  state.observedHost = "";
  state.sampleUrl = "";
  state.sampleRange = "";
  state.livePlaylistUrl = "";
  state.playurlUrls = [];
  state.playurlVideoUrls = [];
  state.autoHost = "";
  state.autoAttempted = false;
  state.nextAutoRefreshCheckAt = 0;
  state.benchmarks = [];
  state.stalledHosts = [];
  await removeRule(tabId);
}

// 直播主机对按播放接口调用轮换分配，让页面按冷却重放一次播放器
// 自己的 playurl 请求，把轮换签发的新集群并入候选池后再选测速对象。
async function harvestLivePlayurlFromPage(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "HARVEST_LIVE_PLAYURL"
    });
    if (response?.ok && Array.isArray(response.urls)) {
      observePlayurlUrls(tabId, response.urls, response.videoUrls);
    }
  } catch {
    // 收割是可选增强；已捕获的同族候选仍然可用。
  }
}

async function runBenchmark(
  tabId,
  requestedHosts = null,
  { preserveStalledHosts = false } = {}
) {
  const state = stateFor(tabId);
  const live = isLiveTab(state);
  if (live) await ensureLiveFamily(tabId, state);
  const sampleUrl = live
    ? liveFamilyUrl(state)
    : state.videoSampleUrl || state.sampleUrl;
  const sampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  if (!sampleUrl || (!live && !sampleRange)) {
    throw new Error("还没有捕获到媒体 URL。请先播放几秒视频，再测速。");
  }
  if (state.benchmarkRunning) {
    throw new Error("测速正在进行中");
  }
  if (live) {
    await harvestLivePlayurlFromPage(tabId);
  }
  if (!state.playurlUrls.length) {
    await refreshPlayurlUrlsFromPage(tabId);
  }

  const config = await getConfig();
  const preferredHost = live ? state.autoHost : config.autoBestHost;
  const allCandidates = await candidatesFor(config, state);
  const requested = Array.isArray(requestedHosts)
    ? new Set(requestedHosts)
    : null;
  const eligible = requested
    ? allCandidates.filter(
        (item) => !item.disabled && requested.has(item.host)
      )
    : allCandidates.filter((item) => !item.disabled);
  const candidates = chooseBenchmarkCandidates(
    eligible,
    preferredHost,
    MAX_BENCHMARK_HOSTS
  );
  if (!candidates.length) throw new Error("没有可测速的候选 CDN");
  const quickSpecs = candidates.map((candidate) =>
    live
      ? buildLiveBenchmarkSpec({
          familyUrl: sampleUrl,
          playurlUrls: state.playurlUrls,
          host: candidate.host,
          maxBytes: QUICK_SAMPLE_BYTES,
          timeoutMs: QUICK_TEST_TIMEOUT_MS,
          stage: "quick"
        })
      : benchmarkSpec(state, candidate, {
          maxBytes: QUICK_SAMPLE_BYTES,
          timeoutMs: QUICK_TEST_TIMEOUT_MS,
          stage: "quick"
        })
  );

  state.benchmarkRunning = true;
  state.benchmarkPhase = "quick";
  state.stalledHosts = preserveStalledHosts
    ? retainRecentStalledHosts(
        state.stalledHosts,
        RECENT_STALL_HOST_LIMIT
      )
    : [];
  appendEvent(tabId, { kind: "benchmark-start", count: candidates.length });
  await removeRule(tabId);
  await pushDiagnostics(tabId);
  try {
    const runSpecs = async (specs, concurrency) => {
      // 直播探测需要解析播放列表并二次拉取分片，统一在后台完成
      //（实测直播边缘节点不校验 Referer）。
      if (live) {
        return mapWithConcurrency(specs, concurrency, (spec) =>
          testCandidate(spec)
        );
      }
      try {
        return await testCandidatesInPage(tabId, specs, concurrency);
      } catch (pageError) {
        appendEvent(tabId, {
          kind: "page-benchmark-error",
          message: pageError?.message || "页面测速失败"
        });
        return mapWithConcurrency(specs, concurrency, (spec) =>
          testCandidate(spec)
        );
      }
    };

    const quickResults = await runSpecs(quickSpecs, 2);
    const finalists = quickResults
      .filter(
        (item) =>
          item?.ok &&
          Number.isFinite(item.mbps) &&
          item.mbps > 0
      )
      .sort(
        (a, b) =>
          b.mbps - a.mbps ||
          (a.ttfbMs || Number.MAX_SAFE_INTEGER) -
            (b.ttfbMs || Number.MAX_SAFE_INTEGER)
      )
      .slice(0, SUSTAINED_FINALISTS);

    state.benchmarkPhase = "sustained";
    await pushDiagnostics(tabId);
    const candidateByHost = new Map(
      candidates.map((candidate) => [candidate.host, candidate])
    );
    const sustainedSpecs = finalists.map((result) =>
      live
        ? buildLiveBenchmarkSpec({
            familyUrl: sampleUrl,
            playurlUrls: state.playurlUrls,
            host: result.host,
            maxBytes: SUSTAINED_SAMPLE_BYTES,
            timeoutMs: SUSTAINED_TEST_TIMEOUT_MS,
            stage: "sustained"
          })
        : benchmarkSpec(state, candidateByHost.get(result.host), {
            maxBytes: SUSTAINED_SAMPLE_BYTES,
            offsetBytes: QUICK_SAMPLE_BYTES,
            timeoutMs: SUSTAINED_TEST_TIMEOUT_MS,
            stage: "sustained"
          })
    );
    const sustainedResults = sustainedSpecs.length
      ? await runSpecs(sustainedSpecs, 1)
      : [];

    const resultsByHost = new Map(
      quickResults.map((item) => [
        item.host,
        { ...item, stage: "quick" }
      ])
    );
    for (const item of sustainedResults) {
      const quick = resultsByHost.get(item.host);
      resultsByHost.set(item.host, {
        ...item,
        stage: "sustained",
        burstMbps: quick?.mbps || 0,
        burstTtfbMs: quick?.ttfbMs
      });
    }
    const results = [...resultsByHost.values()];
    const previous = new Map(state.benchmarks.map((item) => [item.host, item]));
    results.forEach((item) => previous.set(item.host, item));
    state.benchmarks = [...previous.values()];
    await saveBenchmarkHealth(results);

    let best = preserveStalledHosts
      ? selectRecoveryBenchmark(results, "", state.stalledHosts)
      : chooseAutoBenchmark(results, preferredHost);
    if (!best && preserveStalledHosts) {
      state.stalledHosts = [];
      best = chooseAutoBenchmark(results, preferredHost);
    }
    const freshConfig = await getConfig();
    const disabled = new Set(freshConfig.disabledHosts || []);
    if (best && disabled.has(best.host)) best = null;
    if (
      freshConfig.enabled &&
      freshConfig.mode === "auto" &&
      best
    ) {
      state.autoHost = best.host;
      // 直播结果绑定当前流的签发路径，不进入跨页的全局缓存。
      if (!live) {
        await saveConfig({
          autoBestHost: best.host,
          autoBestAt: Date.now(),
          autoBestSchema: BENCHMARK_SCHEMA
        });
      }
      await applyRule(tabId);
    } else if (freshConfig.enabled && freshConfig.mode === "manual") {
      await applyRule(tabId);
    }
    appendEvent(tabId, {
      kind: "benchmark-done",
      host: best?.host || "",
      mbps: best?.mbps || 0,
      sustained: best?.stage !== "quick"
    });
    return { results, best };
  } finally {
    state.benchmarkRunning = false;
    state.benchmarkPhase = "";
    await pushDiagnostics(tabId);
  }
}

async function maybeRunAuto(tabId) {
  const state = stateFor(tabId);
  const live = isLiveTab(state);
  if (live && state.playback) await ensureLiveFamily(tabId, state);
  const sampleUrl = live
    ? liveFamilyUrl(state)
    : state.videoSampleUrl || state.sampleUrl;
  const sampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  if (
    state.benchmarkRunning ||
    !sampleUrl ||
    (!live && !sampleRange)
  ) {
    return;
  }
  const config = await getConfig();
  if (!config.enabled || config.mode !== "auto" || !state.playback) return;
  if (live) {
    // 直播不读写全局缓存：每路流只测一次，流族变化时会重置重测。
    if (state.autoAttempted) return;
  } else {
    const cachedHost = freshAutoHost(config);
    const resultStatus = autoResultStatus(config);
    if (
      shouldReleaseExpiredAutoRule(
        resultStatus,
        cachedHost,
        state.autoHost
      )
    ) {
      const expiredHost = state.autoHost;
      state.autoHost = "";
      state.autoAttempted = false;
      await removeRule(tabId);
      appendEvent(tabId, {
        kind: "expired-rule-released",
        host: expiredHost
      });
      await pushDiagnostics(tabId);
    }
    if (cachedHost && resultStatus === "fresh") {
      if (state.autoAttempted && state.autoHost === cachedHost) return;
      state.autoAttempted = true;
      state.autoHost = cachedHost;
      appendEvent(tabId, {
        kind: "benchmark-cache",
        host: cachedHost
      });
      await applyRule(tabId);
      await pushDiagnostics(tabId);
      return;
    }

    if (cachedHost && state.autoHost !== cachedHost) {
      state.autoHost = cachedHost;
      await applyRule(tabId);
    }
  }

  const now = Date.now();
  if (
    state.autoRefreshChecking ||
    now < state.nextAutoRefreshCheckAt ||
    (
      autoRefreshOwnerTabId !== null &&
      autoRefreshOwnerTabId !== tabId
    )
  ) {
    return;
  }

  state.autoRefreshChecking = true;
  state.nextAutoRefreshCheckAt = now + AUTO_ACTIVITY_RETRY_MS;
  autoRefreshOwnerTabId = tabId;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_PLAYBACK_ACTIVITY"
    });
    const activity = response?.ok ? response.activity : null;
    // 直播的前向缓冲天然只有几秒，安全缓冲门槛只适用于点播。
    const requireSafeBuffer = Boolean(state.autoHost) && !live;
    if (
      !isAutoRefreshActivityEligible(activity, {
        requireSafeBuffer
      })
    ) {
      appendEvent(tabId, {
        kind: "benchmark-deferred",
        reason: activity?.visible
          ? activity?.playing
            ? "buffer"
            : "paused"
          : "hidden"
      });
      return;
    }
    state.autoAttempted = true;
    await runBenchmark(tabId);
  } catch (error) {
    state.nextAutoRefreshCheckAt = Date.now() + AUTO_FAILURE_RETRY_MS;
    appendEvent(tabId, {
      kind: "error",
      message: error?.message || "自动测速失败"
    });
  } finally {
    state.autoRefreshChecking = false;
    if (autoRefreshOwnerTabId === tabId) autoRefreshOwnerTabId = null;
  }
}

async function recoverFromPlaybackStall(tabId, details = {}) {
  const state = stateFor(tabId);
  if (state.recoveryInFlight) {
    return {
      switched: false,
      reason: "in-flight",
      retryAfterMs: MIN_RECOVERY_SWITCH_INTERVAL_MS
    };
  }
  state.recoveryInFlight = true;

  try {
    const config = await getConfig();
    if (
      !config.enabled ||
      config.mode !== "auto" ||
      !state.playback ||
      state.benchmarkRunning
    ) {
      return { switched: false, reason: "inactive" };
    }

    const now = Date.now();
    const lastRecoveryAt = Number(state.lastRecovery?.at) || 0;
    const elapsedSinceRecovery = now - lastRecoveryAt;
    if (
      lastRecoveryAt > 0 &&
      elapsedSinceRecovery < MIN_RECOVERY_SWITCH_INTERVAL_MS
    ) {
      return {
        switched: false,
        reason: "cooldown",
        retryAfterMs:
          MIN_RECOVERY_SWITCH_INTERVAL_MS - elapsedSinceRecovery
      };
    }

    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const currentHost =
      activeRuleTarget(rules, tabId) ||
      state.autoHost ||
      "";
    if (!currentHost) {
      return { switched: false, reason: "no-active-host" };
    }

    const live = isLiveTab(state);
    state.stalledHosts = retainRecentStalledHosts(
      [...state.stalledHosts, currentHost],
      MAX_BENCHMARK_HOSTS
    );
    await rememberPlaybackFailure(currentHost);
    if (!live) {
      await saveConfig({
        autoBestHost: "",
        autoBestAt: 0,
        autoBestSchema: BENCHMARK_SCHEMA
      });
    }

    const disabled = new Set(config.disabledHosts || []);
    const recoveryPlan = planStallRecovery(
      state.benchmarks.filter((item) => !disabled.has(item.host)),
      currentHost,
      state.stalledHosts
    );
    const next = recoveryPlan.candidate;
    if (recoveryPlan.kind === "origin") {
      const fallbackAt = Date.now();
      state.autoHost = "";
      state.autoAttempted = false;
      state.nextAutoRefreshCheckAt = 0;
      await removeRule(tabId);
      state.recoveryCount += 1;
      state.lastRecovery = {
        at: fallbackAt,
        fromHost: currentHost,
        host: "",
        fallback: "origin"
      };
      appendEvent(tabId, {
        kind: "stall-fallback",
        host: currentHost,
        atSecond: Number(details.currentTime) || 0
      });
      await pushDiagnostics(tabId);
      return {
        switched: true,
        fallback: "origin",
        retryBenchmark: recoveryPlan.retryBenchmark,
        fromHost: currentHost,
        host: "",
        recoveryCount: state.recoveryCount
      };
    }

    state.autoHost = next.host;
    const switchedAt = Date.now();
    if (!live) {
      await saveConfig({
        autoBestHost: next.host,
        autoBestAt: switchedAt,
        autoBestSchema: BENCHMARK_SCHEMA
      });
    }
    await applyRule(tabId);
    state.recoveryCount += 1;
    state.lastRecovery = {
      at: switchedAt,
      fromHost: currentHost,
      host: next.host,
      mbps: next.mbps,
      stage: next.stage || "sustained"
    };
    appendEvent(tabId, {
      kind: "stall-switch",
      fromHost: currentHost,
      host: next.host,
      mbps: next.mbps
    });
    await pushDiagnostics(tabId);
    return {
      switched: true,
      fromHost: currentHost,
      host: next.host,
      recoveryCount: state.recoveryCount
    };
  } finally {
    state.recoveryInFlight = false;
  }
}

async function publicState(tabId, pageUrl = "") {
  const config = await getConfig();
  const autoRefreshPolicy = resolveAutoRefreshProfile(
    config.autoRefreshProfile
  );
  const state = pageUrl ? updatePageState(tabId, pageUrl) : stateFor(tabId);
  await ensureLiveFamily(tabId, state);
  if (state.playback && !state.playurlUrls.length) {
    await refreshPlayurlUrlsFromPage(tabId);
  }
  const targetHost =
    config.mode === "auto" ? state.autoHost : config.manualHost;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const activeTarget = activeRuleTarget(rules, tabId);
  const ruleActive = Boolean(activeTarget);
  const ruleHost = activeTarget || targetHost || "";
  const candidates = await candidatesFor(config, state);
  return {
    version: extensionVersion(),
    contentVersion: state.contentVersion,
    applicable: state.playback && isPlaybackUrl(state.pageUrl),
    config,
    observedHost: state.observedHost,
    activeHost: ruleActive ? ruleHost : "",
    ruleActive,
    benchmarkRunning: state.benchmarkRunning,
    benchmarkPhase: state.benchmarkPhase,
    benchmarks: state.benchmarks,
    benchmarkLimit: MAX_BENCHMARK_HOSTS,
    quickSampleBytes: QUICK_SAMPLE_BYTES,
    sustainedSampleBytes: SUSTAINED_SAMPLE_BYTES,
    sustainedFinalists: SUSTAINED_FINALISTS,
    autoRefreshSoftMs: autoRefreshPolicy.softTtlMs,
    autoResultTtlMs: autoRefreshPolicy.hardTtlMs,
    autoRefreshProfiles: Object.values(AUTO_REFRESH_PROFILES),
    autoResultStatus: autoResultStatus(config),
    live: isLiveTab(state),
    sampleKind: isLiveTab(state)
      ? "live"
      : state.videoSampleUrl
        ? "video"
        : "media",
    discoveredCount: isLiveTab(state)
      ? liveCandidateHosts(state.playurlUrls, liveFamilyUrl(state)).length
      : playurlHosts(state).length,
    candidates,
    recoveryCount: state.recoveryCount,
    lastRecovery: state.lastRecovery,
    stalledHosts: state.stalledHosts,
    events: state.events
  };
}

async function diagnosticState(tabId) {
  const config = await getConfig();
  const state = stateFor(tabId);
  const health = await getHostHealth();
  const targetHost =
    config.mode === "auto" ? state.autoHost : config.manualHost;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const activeTarget = activeRuleTarget(rules, tabId);
  const ruleActive = Boolean(activeTarget);
  const ruleHost = activeTarget || targetHost || "";
  return {
    version: extensionVersion(),
    enabled: config.enabled,
    mode: config.mode,
    ruleActive,
    activeHost: ruleActive ? ruleHost : "",
    observedHost: state.observedHost,
    benchmarkRunning: state.benchmarkRunning,
    benchmarkPhase: state.benchmarkPhase,
    benchmarkCount: state.benchmarks.length,
    successfulBenchmarks: state.benchmarks.filter((item) => item.ok).length,
    discoveredCount: playurlHosts(state).length,
    learnedCount: learnedCandidates(health).length,
    recoveryCount: state.recoveryCount,
    autoResultStatus: autoResultStatus(config),
    autoRefreshProfile: config.autoRefreshProfile
  };
}

async function pushDiagnostics(tabId) {
  try {
    const status = await diagnosticState(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "DIAGNOSTIC_STATUS",
      status
    });
  } catch {
    // The content script may not be ready, or the tab may have closed.
  }
}

async function handleMessage(message, sender) {
  const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;

  if (message.type === "READY" || message.type === "NAVIGATION") {
    if (!Number.isInteger(tabId)) return { ok: false };
    const state = updatePageState(
      tabId,
      message.url || sender.tab?.url || ""
    );
    state.contentVersion = message.extensionVersion || "";
    const config = await getConfig();
    const cachedHost = freshAutoHost(config);
    if (config.mode === "auto" && cachedHost && !isLiveTab(state)) {
      state.autoHost = cachedHost;
    }
    if (!state.playback) {
      await removeRule(tabId);
    } else {
      await applyRule(tabId);
      await maybeRunAuto(tabId);
    }
    await pushDiagnostics(tabId);
    return { ok: true };
  }

  if (message.type === "MEDIA_SEEN") {
    if (Number.isInteger(tabId)) {
      updatePageState(tabId, sender.tab?.url || "");
      observeMedia(tabId, message.url, "performance");
    }
    return { ok: true };
  }

  if (message.type === "PLAYURL_URLS") {
    if (!Number.isInteger(tabId)) return { ok: false };
    const state = updatePageState(tabId, sender.tab?.url || "");
    if (!state.playback) return { ok: false };
    const hosts = observePlayurlUrls(
      tabId,
      message.urls,
      message.videoUrls
    );
    await pushDiagnostics(tabId);
    return { ok: true, hosts: hosts.length };
  }

  if (!Number.isInteger(tabId)) throw new Error("找不到当前标签页");

  switch (message.type) {
    case "GET_DIAGNOSTICS":
      if (sender.tab?.url) updatePageState(tabId, sender.tab.url);
      return diagnosticState(tabId);
    case "GET_STATE":
      return publicState(tabId, message.pageUrl);
    case "SET_ENABLED":
      await saveConfig({ enabled: Boolean(message.enabled) });
      await applyToKnownPlaybackTabs();
      await maybeRunAuto(tabId);
      return publicState(tabId);
    case "SET_MODE":
      if (!["auto", "manual"].includes(message.mode)) {
        throw new Error("模式无效");
      }
      await saveConfig({ mode: message.mode });
      if (message.mode === "auto") {
        const state = stateFor(tabId);
        const config = await getConfig();
        state.autoAttempted = false;
        state.stalledHosts = [];
        const cachedHost = freshAutoHost(config);
        if (cachedHost && !isLiveTab(state)) {
          state.autoHost = cachedHost;
        }
        await maybeRunAuto(tabId);
      }
      await applyToKnownPlaybackTabs();
      return publicState(tabId);
    case "SET_AUTO_REFRESH_PROFILE": {
      const policy = resolveAutoRefreshProfile(message.profile);
      if (policy.id !== message.profile) {
        throw new Error("自动复测频率无效");
      }
      await saveConfig({ autoRefreshProfile: policy.id });
      const state = stateFor(tabId);
      state.autoAttempted = false;
      state.nextAutoRefreshCheckAt = 0;
      await maybeRunAuto(tabId);
      await pushDiagnostics(tabId);
      return publicState(tabId);
    }
    case "SET_LIVE_PROTOCOL": {
      if (!["auto", "flv"].includes(message.preference)) {
        throw new Error("直播协议偏好无效");
      }
      const next = await saveConfig({
        liveProtocolPreference: message.preference
      });
      await syncLiveProtocolRule(next);
      const tabs = await chrome.tabs.query({
        url: ["https://live.bilibili.com/*"]
      });
      await Promise.all(
        tabs
          .filter((tab) => Number.isInteger(tab.id) && isPlaybackUrl(tab.url || ""))
          .map(async (tab) => {
            updatePageState(tab.id, tab.url || "");
            await resetLiveTab(tab.id);
            try {
              await chrome.tabs.sendMessage(tab.id, {
                type: "RELOAD_LIVE_PLAYER"
              });
            } catch {
              // 内容脚本未注入时，播放器下一次自然重连也会生效。
            }
            await pushDiagnostics(tab.id);
          })
      );
      return publicState(tabId);
    }
    case "SET_TARGET": {
      const validation = validateCdnHost(message.host);
      if (!validation.ok) throw new Error(validation.error);
      const config = await getConfig();
      if (config.disabledHosts.includes(validation.host)) {
        throw new Error("这个节点已禁用，请先重新启用");
      }
      await saveConfig({ manualHost: validation.host, mode: "manual" });
      await applyToKnownPlaybackTabs();
      return publicState(tabId);
    }
    case "RUN_BENCHMARK":
      await runBenchmark(tabId, message.hosts || null, {
        preserveStalledHosts: Boolean(message.preserveStalledHosts)
      });
      return publicState(tabId);
    case "PLAYBACK_STALL":
      return recoverFromPlaybackStall(tabId, message);
    case "ADD_CUSTOM_HOST": {
      const validation = validateCdnHost(message.host);
      if (!validation.ok) throw new Error(validation.error);
      const config = await getConfig();
      const customHosts = [...new Set([...config.customHosts, validation.host])];
      await saveConfig({ customHosts });
      return publicState(tabId);
    }
    case "SET_HOST_DISABLED": {
      const validation = validateCdnHost(message.host);
      if (!validation.ok) throw new Error(validation.error);
      const disabled = Boolean(message.disabled);
      const config = await getConfig();
      const disabledHosts = new Set(config.disabledHosts);
      if (disabled) {
        disabledHosts.add(validation.host);
      } else {
        disabledHosts.delete(validation.host);
      }
      const patch = {
        disabledHosts: [...disabledHosts]
      };
      if (disabled && config.autoBestHost === validation.host) {
        patch.autoBestHost = "";
        patch.autoBestAt = 0;
        patch.autoBestSchema = BENCHMARK_SCHEMA;
      }
      await saveConfig(patch);
      if (disabled) {
        for (const state of tabStates.values()) {
          if (state.autoHost !== validation.host) continue;
          state.autoHost = "";
          state.autoAttempted = false;
          state.nextAutoRefreshCheckAt = 0;
        }
      }
      await applyToKnownPlaybackTabs();
      if (disabled) await maybeRunAuto(tabId);
      return publicState(tabId);
    }
    default:
      throw new Error("未知操作");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void getConfig().then((config) =>
    chrome.storage.local.set({ [CONFIG_KEY]: config })
  );
});

// 会话规则不跨浏览器会话保留，service worker 每次启动时按配置重建。
void getConfig()
  .then((config) => syncLiveProtocolRule(config))
  .catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({ ok: false, error: error?.message || "操作失败" })
    );
  return true;
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (!isBilibiliInitiator(initiator)) return;
    if (!stateFor(details.tabId).playback && details.documentUrl) {
      updatePageState(details.tabId, details.documentUrl);
    }
    if (stateFor(details.tabId).benchmarkRunning) return;
    observeMedia(details.tabId, details.url, "request");
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (!isBilibiliInitiator(initiator)) return;
    if (!stateFor(details.tabId).playback && details.documentUrl) {
      updatePageState(details.tabId, details.documentUrl);
    }
    if (stateFor(details.tabId).benchmarkRunning) return;
    const rangeHeader = details.requestHeaders?.find(
      (header) => header.name.toLowerCase() === "range"
    )?.value;
    if (rangeHeader) {
      observeMedia(details.tabId, details.url, "range", rangeHeader);
    }
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  },
  ["requestHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (details.tabId < 0 || !isBilibiliInitiator(initiator)) return;
    appendEvent(details.tabId, {
      kind: "completed",
      host: new URL(details.url).hostname,
      status: details.statusCode,
      fromCache: Boolean(details.fromCache)
    });
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (details.tabId < 0 || !isBilibiliInitiator(initiator)) return;
    appendEvent(details.tabId, {
      kind: "request-error",
      host: new URL(details.url).hostname,
      message: details.error
    });
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;
  const state = updatePageState(tabId, url);
  if (!state.playback) void removeRule(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  void chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: allRuleIdsForTab(tabId)
  });
});
