# 口述整理台

一个本地运行的小工具：本地 Whisper 离线转写，DeepSeek 负责把口语内容整理成更清楚的表达。

## 启动

第一次使用本地 Whisper 前，先在项目目录运行一次：

```bash
npm run setup:whisper
```

先安装桌面运行依赖：

```bash
npm install
```

最简单的方式：双击 `启动口述整理台.vbs` 或 `启动口述整理台.cmd`。

它会用 Electron 打开一个独立桌面窗口，不再调用 Microsoft Edge 或 Chrome。关闭窗口后，本地服务也会自动退出。

如果已经生成过桌面版，也可以直接双击 `dist\win-unpacked\口述整理台.exe`。

启动日志会写到：

```text
%LOCALAPPDATA%\VoicePolisher\logs
```

打开后，软件会自动预加载本地 Whisper 模型，并在录音区显示加载进度。默认使用 `small`，启动更快；模型缓存成功后，后续打开不会重新下载，但仍需要几秒把模型加载到显存/内存。

选择模型服务商，把对应 API key 粘贴到窗口里的 `API key` 输入框，点击 `连接`，成功后就可以整理口述内容。API key 默认会保存在本机，下次打开会自动恢复。

也可以用命令行运行：

```bash
npm run desktop
```

如果只想调试本地网页服务，可以运行：

```bash
npm start
```

默认地址：

```text
http://localhost:47831
```

如果端口被占用，服务会自动尝试后面的端口。双击启动脚本默认使用 `47831` 这一段专用端口，并隐藏后台服务窗口。

生成 Windows 独立桌面版：

```bash
npm run build:win
```

生成后的程序会放在 `dist\win-unpacked`，其中 `口述整理台.exe` 就是独立桌面版入口。之后双击 `启动口述整理台.vbs` 会优先打开这个桌面版可执行文件。

## 说明

- Windows 上会优先使用本地 `faster-whisper`，从选中的输入麦克风录音，停止后离线转写，不依赖浏览器听写权限。
- 如果本地 Whisper 不可用，会退回 Windows 系统听写；如果系统听写也不可用，才会退回浏览器听写。
- 针对 NVIDIA 显卡，默认 Whisper 模式是 `small` + `cuda` + `float16`，优先保证启动稳定和响应速度。
- 如果你想提高转写质量，可以在 `.env` 里改成 `WHISPER_MODEL=medium` 或 `WHISPER_MODEL=large-v3`。`large-v3` 首次需要完整下载数 GB 的 `model.bin`，下载中断会留下 `.incomplete` 残片。
- 如果本机缺少 `cublas64_12.dll` 等 CUDA 运行库，软件会自动切换到 `cpu/int8`，避免录音后报 DLL 错误。CPU 模式可以正常使用，但转写会慢一些；安装 CUDA 12/cuBLAS 运行库后可恢复 GPU 加速。
- 也可以在 `.env` 里覆盖 `WHISPER_DEVICE` 和 `WHISPER_COMPUTE_TYPE`，例如调试时用 `WHISPER_DEVICE=cpu`、`WHISPER_COMPUTE_TYPE=int8`。
- 整理逻辑会做忠实护栏：纯数字、符号、极短内容会原样返回，避免 AI 自动续写或编造上下文。
- 支持 DeepSeek、OpenAI、Claude、Gemini、OpenRouter、通义千问、智谱、Kimi、Groq、Ollama 和自定义 OpenAI-compatible API。
- API key 默认保存在当前桌面应用的本地存储里；取消勾选 `记住` 会停止保存当前服务商的 key。
- 也可以复制 `.env.example` 为 `.env`，在 `.env` 里填入对应服务商的 API key。
- 页面里的历史记录保存在浏览器 `localStorage`。
- 默认模型服务商是 DeepSeek，可在 `.env` 或页面里切换到其他主流模型服务。
