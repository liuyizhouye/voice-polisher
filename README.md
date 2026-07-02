# 口述整理台

一个本地运行的小工具：本地 Whisper 离线转写，DeepSeek 负责把口语内容整理成更清楚的表达。

## 启动

第一次使用本地 Whisper 前，先在项目目录运行一次：

```bash
npm run setup:whisper
```

最简单的方式：双击 `启动口述整理台.vbs`。

它会自动在后台启动本地服务，并用 Edge/Chrome 的应用窗口打开。这个窗口没有地址栏和标签页，看起来更像一个普通桌面软件；关闭窗口后，后台服务也会自动退出。

如果你习惯双击原来的 `启动口述整理台.cmd`，也可以继续用，它会转交给无终端启动器。

打开后，软件会自动预加载本地 Whisper 模型，并在录音区显示下载/加载进度条。第一次使用 `large-v3` 会比较久；模型下载完成后会缓存在本机，后续打开会快很多。

把 DeepSeek API key 粘贴到窗口里的 `API key` 输入框，点击 `连接`，成功后就可以整理口述内容。

也可以用命令行运行：

```bash
npm start
```

默认地址：

```text
http://localhost:47831
```

如果端口被占用，服务会自动尝试后面的端口。双击启动脚本默认使用 `47831` 这一段专用端口，并隐藏后台服务窗口。

## 说明

- Windows 上会优先使用本地 `faster-whisper`，从选中的输入麦克风录音，停止后离线转写，不依赖浏览器听写权限。
- 如果本地 Whisper 不可用，会退回 Windows 系统听写；如果系统听写也不可用，才会退回浏览器听写。
- 针对 NVIDIA 显卡，默认 Whisper 模式是 `large-v3` + `cuda` + `float16`，优先保证中文转写质量。
- 如果显存或下载速度不够，可以在 `.env` 里临时改小：`WHISPER_MODEL=medium`、`WHISPER_MODEL=small`。但默认推荐保持 `large-v3`。
- 也可以在 `.env` 里覆盖 `WHISPER_DEVICE` 和 `WHISPER_COMPUTE_TYPE`，例如调试时用 `WHISPER_DEVICE=cpu`、`WHISPER_COMPUTE_TYPE=int8`。
- 整理逻辑会做忠实护栏：纯数字、符号、极短内容会原样返回，避免 AI 自动续写或编造上下文。
- API key 可以直接临时填在页面的 API key 输入框；勾选 `记住` 后会保存在当前浏览器本地。
- 也可以复制 `.env.example` 为 `.env`，在 `.env` 里填入 `DEEPSEEK_API_KEY`。
- 页面里的历史记录保存在浏览器 `localStorage`。
- 默认模型是 `deepseek-v4-flash`，可在 `.env` 或页面里改成其他 DeepSeek 模型。
