// 直播策略层：候选族识别、播放列表解析与探测规格。
// 直播与点播共享 core.js 的 URL 白名单与替换原语，但端点语义不同：
// 直播签名不绑定主机名、却绑定协议族路径（跨族 404），候选只能来自
// 当前流签发的同路径节点。这里的函数全部无副作用，便于独立测试。
import {
  isCandidateMediaUrl,
  replaceMediaHost,
  validateCdnHost
} from "./core.js";

export function mediaKindFromUrl(value) {
  try {
    return new URL(value).pathname.includes("/live-bvc/") ? "live" : "vod";
  } catch {
    return "vod";
  }
}

export function isLivePlaylistUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.pathname.includes("/live-bvc/") &&
      /\.m3u8(?:$|[?#])/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function latestLiveSegmentUrl(playlistText, playlistUrl) {
  if (
    typeof playlistText !== "string" ||
    !playlistText.trimStart().startsWith("#EXTM3U")
  ) {
    return "";
  }
  let base;
  try {
    base = new URL(playlistUrl);
  } catch {
    return "";
  }
  const uris = [];
  for (const line of playlistText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const mapMatch = /^#EXT-X-MAP:.*?URI="([^"]+)"/.exec(trimmed);
      if (mapMatch) uris.unshift(mapMatch[1]);
      continue;
    }
    uris.push(trimmed);
  }
  for (let index = uris.length - 1; index >= 0; index -= 1) {
    try {
      const resolved = new URL(uris[index], base);
      if (/\.m3u8(?:$|[?#])/i.test(resolved.pathname)) continue;
      if (resolved.hostname !== base.hostname) continue;
      return resolved.href;
    } catch {
      continue;
    }
  }
  return "";
}

export function liveFamilyUrl({ livePlaylistUrl = "", sampleUrl = "" } = {}) {
  if (livePlaylistUrl) return livePlaylistUrl;
  return sampleUrl && mediaKindFromUrl(sampleUrl) === "live" ? sampleUrl : "";
}

// 同一路流在不同 CDN 集群下的路径只差 /live-bvc/<集群号>/ 前缀，
// 流名（含清晰度/编码后缀）与协议入口保持一致。key 相同 = 同一路流的
// 同一协议形态，可以互相切换；key 不同（协议、清晰度或重新推流）不可混用。
export function liveStreamKey(value) {
  try {
    const match = /^\/live-bvc\/\d+\/(.+)$/.exec(new URL(value).pathname);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export function liveClusterPrefix(value) {
  try {
    const match = /^(\/live-bvc\/\d+\/)/.exec(new URL(value).pathname);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export function livePlayurlUrls(playurlUrls, familyUrl) {
  const key = liveStreamKey(familyUrl);
  if (!key || !Array.isArray(playurlUrls)) return [];
  return playurlUrls.filter(
    (value) => isCandidateMediaUrl(value) && liveStreamKey(value) === key
  );
}

export function liveCandidateHosts(playurlUrls, familyUrl) {
  return [
    ...new Set(
      livePlayurlUrls(playurlUrls, familyUrl).map(
        (value) => new URL(value).hostname
      )
    )
  ];
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// FLV 优先：改写播放接口请求的 protocol 参数，让 B 站只签发 http_stream
// （FLV 长连接）。只改自己浏览器发出的请求参数，不触碰响应内容。
// 实测依据：1 秒小分段 HLS 在高 RTT 链路上每段都付一次往返税并反复冷启动，
// 同链路 FLV 长连接可稳定跟上实时（docs/research/live-stream-lag-investigation）。
export const LIVE_PLAYURL_API_REGEX =
  "^https://api\\.live\\.bilibili\\.com/xlive/web-room/" +
  "(?:v2/index/getRoomPlayInfo|v1/index/getInfoByRoom)";

export function buildLiveProtocolRule({ id }) {
  if (!Number.isInteger(id) || id <= 0) throw new TypeError("规则 ID 无效");
  return {
    id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        transform: {
          queryTransform: {
            addOrReplaceParams: [{ key: "protocol", value: "0" }]
          }
        }
      }
    },
    condition: {
      initiatorDomains: ["bilibili.com"],
      regexFilter: LIVE_PLAYURL_API_REGEX,
      resourceTypes: ["xmlhttprequest"]
    }
  };
}

// 跨集群切换的两条规则（实测集群会 403 外族路径，单纯换 host 不可用）：
// 1) 入口规则：把任何已知同流入口路径（播放列表/FLV）整体重定向到目标
//    集群自己的完整签发 URL——签名随 URL 一起替换，始终合法。
// 2) 前缀规则：把旧集群前缀下的其余请求（HLS 分段，无查询参数）按
//    /live-bvc/<旧集群>/ → /live-bvc/<目标集群>/ 映射。分段文件名来自
//    已被规则 1 重定向的目标集群播放列表，因此无论播放器用原始 URL
//    还是重定向后的 URL 解析相对路径，请求都能落到目标集群的合法路径。
// 同集群兄弟节点（路径完全相同）不需要这套规则，返回空数组，
// 调用方退回单纯的 host 替换规则。
export function buildLiveRedirectRules({ tabId, ruleIds, targetUrl, familyUrls }) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("标签页 ID 无效");
  if (!Array.isArray(ruleIds) || ruleIds.length < 2) {
    throw new TypeError("规则 ID 不足");
  }
  const target = new URL(targetUrl);
  const validation = validateCdnHost(target.hostname);
  if (!validation.ok) throw new TypeError(validation.error);
  const targetKey = liveStreamKey(targetUrl);
  const targetPrefix = liveClusterPrefix(targetUrl);
  if (!targetKey || !targetPrefix) throw new TypeError("目标不是直播媒体 URL");

  const sameKeyUrls = (Array.isArray(familyUrls) ? familyUrls : []).filter(
    (value) => liveStreamKey(value) === targetKey
  );
  const entryPaths = [
    ...new Set(
      sameKeyUrls
        .map((value) => new URL(value).pathname)
        .filter((pathname) => pathname !== target.pathname)
    )
  ].slice(0, 6);
  const prefixes = [
    ...new Set(
      sameKeyUrls
        .map((value) => liveClusterPrefix(value))
        .filter((prefix) => prefix && prefix !== targetPrefix)
    )
  ].slice(0, ruleIds.length - 1);

  const condition = {
    tabIds: [tabId],
    initiatorDomains: ["bilibili.com"],
    requestDomains: ["bilivideo.com"],
    resourceTypes: ["media", "xmlhttprequest", "other"]
  };
  const rules = [];
  if (entryPaths.length) {
    rules.push({
      id: ruleIds[0],
      priority: 2,
      action: { type: "redirect", redirect: { url: target.href } },
      condition: {
        ...condition,
        regexFilter: `^https?://[^/]+(?:${entryPaths
          .map(escapeRegex)
          .join("|")})(?:[?#]|$)`
      }
    });
  }
  prefixes.forEach((prefix, index) => {
    rules.push({
      id: ruleIds[index + 1],
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution: `https://${target.hostname}${targetPrefix}\\1`
        }
      },
      condition: {
        ...condition,
        regexFilter: `^https?://[^/]+${escapeRegex(prefix)}(.*)$`
      }
    });
  });
  return rules;
}

export function buildLiveBenchmarkSpec({
  familyUrl,
  playurlUrls = [],
  host,
  maxBytes,
  timeoutMs,
  stage
}) {
  // 轮换签发的主机带各自的签名参数（cdn= 在 sigparams 内），
  // 优先用该主机自己的完整签发 URL，换 host 只是兜底。
  const directUrl = livePlayurlUrls(playurlUrls, familyUrl).find(
    (value) => new URL(value).hostname === host
  );
  const url = directUrl || replaceMediaHost(familyUrl, host);
  return {
    host,
    kind: "live",
    url,
    playlist: isLivePlaylistUrl(url),
    direct: Boolean(directUrl),
    maxBytes,
    timeoutMs,
    stage
  };
}
