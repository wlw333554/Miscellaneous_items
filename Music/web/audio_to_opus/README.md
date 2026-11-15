# 音频转 Opus（浏览器本地转码）

FLAC / MP3 / M4A（以及 wav/aac/ogg/wma 等）→ **.opus**（Ogg Opus），纯浏览器本地转码，不上传。
双击 `audio-to-opus.html` 即可使用，无需联网、无需服务器。

## 文件结构

| 文件 | 作用 |
|---|---|
| `audio-to-opus.html` | 页面骨架：界面样式与 HTML 结构 |
| `audio-to-opus.app.js` | 本页面的 UI 逻辑（文件列表 / 设置 / 下载 / 打包 zip） |
| `opus-transcoder.js` | **可复用转码库**（对外暴露 `window.OpusTranscoder`），内含 Worker 源码与 Ogg 封装器 |
| `engine/ffmpeg-core.wasm.gz.b64.js` | ffmpeg.wasm 内核二进制（gzip+base64），定义全局 `FFmpegCoreAsset` |
| `engine/ogg-opus-encoder.wasm.b64.js` | libopus 编码器 + Ogg 封装器 wasm 二进制（base64），定义全局 `OggOpusEncoderAsset` |

`engine/` 与 `.js` 文件需和 HTML 放在一起（保持相对路径）。缺失引擎文件时页面会给出明确提示。

## 在其他网页中复用转码库

```html
<!-- 1. 引擎二进制（与 opus-transcoder.js 的相对路径保持 engine/ 不变即可） -->
<script src="engine/ffmpeg-core.wasm.gz.b64.js"></script>
<script src="engine/ogg-opus-encoder.wasm.b64.js"></script>
<!-- 2. 转码库 -->
<script src="opus-transcoder.js"></script>
<script>
  const t = new OpusTranscoder();

  // 加载引擎（幂等，可多次调用；建议在用户操作前预热）
  await t.load(p => console.log(p.text, Math.round(p.pct * 100) + '%'));

  // 转换一个文件
  const r = await t.convert(fileInput.files[0], {
    channels: 'keep',   // 'keep' 按源文件声道数（>2 声道混缩为立体声）| 1 | 2
    bitrate: 32,        // 目标码率 kbps（VBR，实际围绕该值浮动）
    frameMs: 60,        // 帧长 20 | 40 | 60（60ms 帧头开销最小）
    voip: false,        // true 时按语音优化（application=voip）
    keepMeta: true      // 保留 title/artist/album 等文字标签
  }, p => console.log(p.phase, Math.round(p.ratio * 100) + '%'));

  // r = { blob, bytes, duration, kbps, name }
  downloadLink.href = URL.createObjectURL(r.blob);
  downloadLink.download = r.name;   // 形如 xxx.opus
</script>
```

注意：
- 页面自带启动自检：如果 opus-transcoder.js / engine 下的引擎文件没跟 HTML 放在一起，
  页面顶部会出现红色提示条，指明缺少哪个文件（正常情况下不会出现）。
- 二进制通过 `window.FFmpegCoreAsset` / `window.OggOpusEncoderAsset` 全局对象传递，
  想换来源（比如自己的 CDN）只需提供同结构的全局对象。
- Worker 由库内部用 Blob 创建（Chrome 禁止 file:// 页面直接 `new Worker('file://…')`），
  因此 Worker 源码打包在 `opus-transcoder.js` 内部，无需单独文件。
- 浏览器要求：支持 WebAssembly、`DecompressionStream`（Chrome/Edge 80+、Firefox 113+、Safari 16.4+）。
- 内存限制：全部在内存中处理，单文件建议 ≤ 300MB。
