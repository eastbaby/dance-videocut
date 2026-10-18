# Dance Videocut

一个 Mac 本地客户端视频剪辑工具，用来把多人集体跳舞视频裁成个人居中的竖版成片。

## 功能

- 选择本地视频文件，不上传云端。
- 在原视频中拖拽框选自己。
- 默认导出 `9:16` 竖版，也支持 `1:1`、`4:5`、`16:9`。
- 通过“人物占画面高度”控制放大或缩小，裁切窗口会优先保证整个人不被裁掉。
- 支持 AI 姿态追踪；模型不可用时自动切换成本地视觉追踪。
- 支持暂停后重新框选，并添加手动关键帧修正。
- 支持选择本地替换音乐、分析源视频和替换音乐节拍，并在导出 MP4 时替换原音频。
- 桌面客户端本地导出 MP4，并内置 FFmpeg 二进制兜底。
- Electron 客户端壳，支持原生文件选择、本地节拍分析和本地引擎诊断。

## 启动

网页预览模式：

```bash
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:5180/
```

桌面客户端模式：

```bash
npm run dev:desktop
```

生成可安装的 macOS DMG（Apple Silicon）：

```bash
npm run package:mac
```

构建产物：

```text
release/Dance Videocut-1.0.0-arm64.dmg
```

以后每完成一轮修改，运行以下命令即可自动递增版本号、打包 Python 引擎与 FFmpeg，并生成新的 DMG：

```bash
npm run release:mac          # 1.0.0 -> 1.0.1
npm run release:mac:minor    # 1.0.0 -> 1.1.0
npm run release:mac:major    # 1.0.0 -> 2.0.0
```

这台机器尚未配置 Apple Developer 签名证书，因此 DMG 是未公证版本；首次安装后如被 macOS 拦截，请在“系统设置 → 隐私与安全性”中点击“仍要打开”。应用自身已包含导出引擎和 FFmpeg，不依赖用户另行安装 Python 或 FFmpeg。

## 使用流程

1. 点击“选择视频”。
2. 在原视频里拖拽框出自己，框要包含头顶和脚底。
3. 选择画面比例，默认 `9:16`。
4. 调整“人物占画面高度”，数值越大人物越近。
5. 点击“智能追踪”。
6. 如追踪偏移，暂停视频，重新框选并点击“关键帧”。
7. 如需音乐对拍，切到右侧“音频对齐”，选择已保存到本机的目标音乐，点击“分析对拍”，在双轨时间线里分别开关原声轨和新音频轨，必要时微调首拍偏移和音乐速度。
8. 点击“导出”，桌面客户端会导出 MP4；选择了替换音乐时会用该音乐替换原视频音轨。

## 说明

AI 姿态追踪使用的是 MediaPipe Pose Landmarker Lite float16 模型。当前网络无法加载模型时，工具会自动切换到本地模板视觉追踪，不会卡死在模型加载状态。

桌面客户端会优先走本地 Python/FFmpeg 引擎导出 MP4。先同步 uv 后端环境：

```bash
uv sync --extra tracking
```

项目已通过 `ffmpeg-static` 提供 FFmpeg 二进制兜底；如果系统安装了 FFmpeg，也可通过 `FFMPEG_PATH` 指定。

下一阶段的正式本地引擎路线见 [engine/README.md](engine/README.md)：YOLO/RTMPose/ByteTrack/FFmpeg，SAM2 作为高精度模式。

开发版会检查 `.venv` 的 YOLO 依赖，缺失时使用打包所用的 `build/native-engine-venv-py312` 环境执行最新 Python 源码。模型从项目根目录加载；安装版从应用内置资源加载，不依赖开发环境。Electron 主进程或运行环境配置修改后需重启开发版，前端修改仍支持热更新。

## Repository and product name

- Repository and local directory: `dance-videocut`
- Desktop application: **Dance Videocut**
- Remote: `git@github.com:eastbaby/dance-videocut.git`

The application keeps its existing bundle identifier (`com.danceframe.studio`)
and internal engine/IPC names for compatibility with earlier installations.
Generated installers, build directories, virtual environments and local media
are excluded from Git. The bundled `yolov8n-pose.pt` model is retained so the
release build has its required model without an extra download.
