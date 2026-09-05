# AI 短视频切片 Demo

把长播客自动剪成多个带悬浮字幕的竖版短视频，用于课堂/路演展示。

## 效果

输入：一段横版播客视频（或内置合成样例）  
输出：3 条 1080×1920 竖版短视频，带大字幕、标题条、模糊背景，可直接下载播放。

## 可视化 Web UI（推荐课堂展示）

最方便的展示方式：启动一个本地网页，点击按钮即可生成并在线预览、下载。

```bash
AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
AGENTCUT_FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe \
pnpm demo:shorts:web
```

然后浏览器打开 `http://127.0.0.1:4400`，点击「使用内置样例生成」。页面会实时显示进度，生成完成后可直接播放 3 条竖版短视频，也可逐条下载。

## 命令行运行

```bash
# 使用内置合成播客样例（无需素材、无版权风险）
AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
AGENTCUT_FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe \
pnpm demo:shorts
```

运行结束后会输出 3 个可下载文件路径，例如：

```
/tmp/agentcut-shorts-demo/clip-01/short.mp4
/tmp/agentcut-shorts-demo/clip-02/short.mp4
/tmp/agentcut-shorts-demo/clip-03/short.mp4
```

## 使用自己的视频

```bash
pnpm demo:shorts:custom -- /path/to/your/podcast.mp4
```

Web UI 当前只支持内置样例；命令行模式支持任意本地英文播客视频。

## 给老师展示的话术（1-2 分钟）

1. **定位**：AgentCut 不只是剪辑工具，它的 ASR + 候选检测能力可以支撑「AI 短视频生成」——把国外长播客自动切片、加字幕、做成可发平台的竖版视频。
2. **演示**：打开 Web UI，点击生成按钮，页面会显示「合成播客 → ASR 转写 → 选择高光 → 渲染竖版」的实时进度。
3. **看视频**：生成完成后播放 3 条 1080×1920 竖版短视频，展示大字幕、标题条、背景模糊的效果。
4. **边界**：目前只做「切片+字幕+竖版渲染+本地文件」，还没有做平台一键分发；分发需要各平台 API 授权，不在本次 demo 范围。

## 实现说明

- 复用 AgentCut 的 `packages/asr-worker`（mlx-whisper）做英文词级转写。
- 高光选择：合并连续 ASR 句子，生成 25–40 秒候选片段，按词密度排序并去重。
- 渲染：ffmpeg `filter_complex` 实现竖版画布 + 模糊背景 + 居中视频 + ASS 悬浮字幕 + 标题条。
- 全部代码在 `demos/short-video-generator/`，不改动 AgentCut 核心结构与 Gate 证据。

## 环境要求

- macOS（使用系统 `say` TTS 生成样例）
- `ffmpeg` + `ffprobe`（推荐 homebrew `ffmpeg-full`，带 libass）
- AgentCut `packages/asr-worker/.venv` 已配置好 mlx-whisper
