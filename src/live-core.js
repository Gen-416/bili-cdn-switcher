// 直播策略层：候选族识别、播放列表解析与探测规格。
// 直播与点播共享 core.js 的 URL 白名单与替换原语，但端点语义不同：
// 直播签名不绑定主机名、却绑定协议族路径（跨族 404），候选只能来自
// 当前流签发的同路径节点。这里的函数全部无副作用，便于独立测试。
import {
  isCandidateMediaUrl,
  replaceMediaHost,
  sameMediaPath
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

export function livePlayurlUrls(playurlUrls, familyUrl) {
  if (!familyUrl || !Array.isArray(playurlUrls)) return [];
  return playurlUrls.filter(
    (value) => isCandidateMediaUrl(value) && sameMediaPath(value, familyUrl)
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
