# B 站直播(Web)卡顿根因检测报告

日期:2026-08-18
目的:为 bili-cdn-switcher 增加**直播场景**支持提供实测依据。本文档自包含,不依赖原对话上下文。
复现脚本:`cursor处理/bili-live-diag.js`(可整段粘贴进直播间页面的 DevTools Console,约 90 秒输出线路测速表 + 播放健康统计 + 自动判定)。

## TL;DR

Web 端直播卡顿的根因是:**播放器被调度到一台劣化的 `ov-gotcha` 主节点后不会自行换线**,叠加 HLS 1 秒小分段对高 RTT 的放大效应。解码侧完全无压力(丢帧 0)。同一个 94KB 分段在备用主机(`b` 后缀)上快 8 倍,且**同一套 URL 签名参数跨主/备主机通用**——这意味着 switcher 现有的"候选测速 + 重定向"架构可以直接套用到直播,无需重新取流。

## 1. 测试环境与局限

- 时间:2026-08-18(UTC+8 晚间),海外网络环境(与 README 中 VOD 卡顿场景相同)。
- 浏览器:本机 Chromium(Claude Code 内置浏览器面板),**未登录**。
- 测试房间:`live.bilibili.com/3044248`(页面重定向到短号 `721`),高人气直播间。
- 局限:未登录被限制在 qn=250(720p HEVC `minihevc` 流,实测码率 ~1.6 Mbps)。登录后原画 qn=10000 码率高数倍,对慢节点的要求更苛刻,本文结论只会加重、不会反转。定量数字是单点单时段测量,数值本身会随时间波动,但结构性结论(主/备差距、协议形态差异)在测试期内稳定复现。

## 2. 测试方法

均在直播间页面上下文内用 DevTools/注入 JS 完成,可被扩展 content script 复用:

1. **线路枚举**:`GET https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id={id}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`(带 cookie)。遍历 `data.playurl_info.playurl.stream[].format[].codec[].url_info[]`,完整流地址 = `url_info.host + codec.base_url + url_info.extra`。
2. **段级计量**:`PerformanceObserver`(resource 条目)记录每个 `.m4s`/`.m3u8` 请求的 `duration`。注意:CDN 响应无 `Timing-Allow-Origin`,跨域下 `transferSize`/`responseStart`/`nextHopProtocol` 均被置零,**只有 `duration` 可用**;要拿 TTFB 需自己 `fetch` 计时。
3. **播放健康采样**:每秒读 `video.buffered` 末端减 `currentTime`(缓冲余量)、`getVideoPlaybackQuality()`(丢帧/总帧)、监听 `waiting`/`stalled` 事件,持续 97 秒。
4. **主机测速**:
   - m3u8(约 1.5KB)整包计时 ≈ RTT + 节点调度开销;
   - 最新数据分段(`.m4s`)整包下载计时 → 吞吐;
   - FLV 用 `fetch` + `ReadableStream` 流式读 5–15 秒统计字节数 → 持续吞吐(注意开头有回填突发,前几秒数值偏高)。
5. **同段对决**:从主/备两台主机的 playlist 取**同一个序号**的 m4s,复用同一套签名参数分别下载计时——排除段大小差异,纯比主机。

## 3. 关键数据

### 3.1 线路调度(未登录,qn=250,accept_qn=[10000,400,250])

全部候选均为 `ov-` 前缀海外节点池,主机名规律 `d1--ov-gotchaNNN.bilivideo.com` + 备用机 `NNNb`:

| 协议/格式 | 主机对 | live-bvc 路径号 |
|---|---|---|
| http_stream / flv (avc, hevc) | ov-gotcha07/07b(第一次调用)→ **05/05b**(第二次调用) | 543161 / 907198 |
| http_hls / ts (avc, hevc) | ov-gotcha105 / 105b | 250923 / 724241 |
| http_hls / fmp4 (avc, hevc) | ov-gotcha207 / 207b | 195992 / 552056 |

两点对 switcher 重要:

- **API 每次调用会轮换主机分配**(FLV 从 07/07b 变成 05/05b)→ 重复调用可累积候选池,和 VOD 的 backup_url 逻辑类似。
- `base_url` 的 `/live-bvc/{数字}/` 路径号按"协议×格式"不同而不同 → **只能在同一 base_url 下换 host,不能跨格式拼路径**。

播放器实际选择:`http_hls/fmp4/hevc @ d1--ov-gotcha207`(主机对中的**主机**,且始终不切换)。

### 3.2 主机测速

| 测试 | 节点 | 结果 |
|---|---|---|
| m3u8 索引(~1.5KB) | ov-gotcha105 | 1565 ms |
| m3u8 索引 | ov-gotcha105b | 845 ms |
| m3u8 索引(两次) | ov-gotcha207(播放器在用) | 1239 / 2593 ms |
| m3u8 索引(两次) | ov-gotcha207b | 598 / 612 ms |
| **同一个 94KB m4s 段** | **ov-gotcha207** | **945 ms(0.81 Mbps)** |
| **同一个 94KB m4s 段** | **ov-gotcha207b** | **113 ms(6.8 Mbps)** |
| FLV 建连 + 4s 读 | ov-gotcha05 | TTFB 4731 ms(!),随后突发 7.24 Mbps |
| FLV 建连 + 4s 读 | ov-gotcha05b | TTFB 424 ms,2.37 Mbps |
| FLV 持续读 15s | ov-gotcha05b | TTFB 681 ms,稳定 1.61 Mbps ≈ 直播实际码率,无断流 |

参考:正常 CDN 边缘节点拉 1.5KB 文件应 <100ms。本轮**所有** ov-gotcha 节点的 m3u8 延迟都在 600ms 以上,主机普遍比备机慢一倍以上,主观感受"全员偏慢、主机灾难"。

### 3.3 播放健康(97 秒,fmp4 hevc @ ov-gotcha207)

- 卡顿(`waiting`)事件:**31 次**;缓冲余量 <0.5s 的时间共 **31 秒**,多次触底为 0(最高仅 11.7s)。
- m4s 下载耗时(段长约 1s):**p50=949ms,p90=3887ms,max=7584ms**;54 段中 **25 段 >1s**,即下载持续跑输实时,缓冲净流出。
- **丢帧 0 / 196 帧** → 解码(含 HEVC)零压力,硬件加速无关,可排除解码侧。

### 3.4 根因链与"手机不卡"的解释

```
getRoomPlayInfo 把 Web 端全部调度到 ov-gotcha 池
  → 播放器选 fmp4-HLS + 主机 207,之后永不换线
    → 该主机劣化(RTT 高 + 吞吐 0.8Mbps)
      → 1s 小分段,每段都付一次请求开销,25/54 段超时
        → 缓冲耗尽,每 3 秒一卡
```

同网络手机 App 正常的原因:App 走独立调度接口(节点池不同)、用 FLV/私有协议**单长连接**(建连后对高 RTT 不敏感,3.2 中 FLV 实测能跟上实时)、卡顿时客户端会自动换线。三个因素 Web 端一个都没有。

## 4. 对 bili-cdn-switcher 的工程建议

1. **拦截范围**:直播媒体路径是 `*.bilivideo.com/live-bvc/*`(VOD 是 `upos-*`)。直播主机名形态 `d1--ov-gotchaNNN[b].bilivideo.com`(国内为 `cn-gotcha`);另有已知劣质 PCDN 形态 `*.mcdn.bilivideo.cn:486`、`*.szbdyd.com`(xy P2P),候选中出现时建议默认降权或禁用。
2. **重定向可行性(已实测)**:同一 `base_url` + 同一套签名参数(`expires/oi/trid/sig` 等)在主/备主机上均返回 200——把发往慢主机的分段请求 redirect 到快主机**不需要重新取流**。3.1 的路径号限制意味着重定向只应做 host 替换,不动路径。
3. **候选池**:来自 `getRoomPlayInfo` 的 `url_info[]`(每个 codec 2 台),重复调用会轮换出更多主机;短号可直接作 `room_id` 传参(实测 721 有效)。
4. **测速指标要为直播重新设计**(与 VOD 的大文件吞吐不同):
   - 健康度核心指标 = **分段下载耗时 / 段时长**(>1 即跑输实时;段时长可从 m3u8 `#EXTINF` 读,当前为 1s);
   - m3u8 整包延迟作 RTT 代理(参考阈值:>500ms 为差);
   - FLV 候选用流式读 3–5s 的持续吞吐 vs 码率(注意剔除开头回填突发,或直接看 5s 后的稳态速率)。
5. **换线策略差异**:直播缓冲余量常态只有几秒(本轮最高 11.7s),没有 VOD 那种"缓冲充足再复测"的安全窗口——复测本身也在抢实时带宽,应更保守(低频、单请求、小样本)。HLS 下换线是零成本的(下一段直接发给新主机);FLV 换线 = 断流重连,代价高,应只在持续跑输实时时触发。README 中"缓冲持续下降且即将耗尽时保守提前切换"的兜底逻辑对直播同样适用,但阈值要按秒级缓冲重标定。
6. **fmp4 的 init 段**:`h*.m4s`(header/init segment)与数据段建议保持同主机获取,避免边缘 case;实测未发现跨主机不兼容,但成本为零,没必要冒险。
7. **判"网络 vs 解码"**:`getVideoPlaybackQuality()` 丢帧比例 >5% 才考虑解码侧;本轮为 0,直播卡顿场景默认按网络侧处理。
8. **CORS 现实约束**:live-bvc CDN 允许来自 `live.bilibili.com` 的跨域 fetch(content script 测速可行),但无 `Timing-Allow-Origin`,Resource Timing 拿不到 TTFB/大小——测速必须自己 fetch 计时,不能只靠 PerformanceObserver。

## 5. 一句话给实现者

把现有 VOD 流程里的"候选 = upos 域名 + backup_url、指标 = 大文件吞吐"替换为"候选 = live-bvc 主/备 gotcha 主机(host-only 替换)、指标 = 段耗时/段时长 + m3u8 RTT",重定向机制本身不用改——签名跨主机通用这一点已实测成立。
