# 变更记录

本项目的所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0] - 2026-10-19

### 新增

- 侧边栏顶部与状态栏会一直提示「请登录 / 登录已过期，请重新登录」，点一下即可登录。
  以前会话过期只弹一次错误，之后每次操作都失败却看不出原因。

### 修复

- 公式渲染不再依赖 CDN：MathJax 打进 `vendor/`（`tex-svg.js`，SVG 输出、自包含不带字体），
  断网或有代理拦截时也能正常渲染。以前 CDN 拉不到就只剩原始的 `\(A\)`。
- 题面里的图片（`~/xxx.jpg`）解析到 PTA 图床，预览面板能正常显示，不再裂图。

- 离线测试 356 → 375 项。

## [0.1.3] - 2026-10-10

### 修复

- 题面里的行内公式（`$$…$$`）不再把句子切断，改为行内渲染。
- 展开「尚未开始 / 已截止」的题集不再显示 403 红叉，改为提示原因；其它错误照常抛出。
- 「在线测试」通知不再显示 `NEUTRAL`，改为报告测试点结果；编译失败直接提示编译错误。
- 本地样例未通过时改用警告提示，并在消息里写明原因。
- 本地跑样例前会先保存当前文件 —— 提交 / 在线测试用的是编辑器内容（含未保存改动），
  本地跑样例编译的却是磁盘上的文件，不存盘两边看到的代码不一样。
- 面板「刷新题面」修复为真正回 PTA 重新拉取并重写本地文件，原先只是重画面板。
- 预览面板不再重复显示 `problem.md` 自带的标题与元信息。
- 题面已含「输入样例 / 输出样例」时不再重复生成「样例」小节。

### 变更

- `problem.md` 顶部只保留时限与内存，其余元信息移至文末「详细信息」。
- 预览面板与 `problem.md` 使用同一套信息布局（新增 `src/problemInfo.js`）。
- 预览面板字号增大，尺寸改用 `em` 相对单位；行内代码按 PTA 网页的样式标红。
- 内置 C++ 模板头文件改为 `<iostream>`，`@pintia note` 块移至文件末尾。
- readme 修正安装示例里的 vsix 文件名。

- 离线测试 280 → 341 项。

## [0.1.2] - 2026-10-10

### 修复

- **修掉「打开题目预览失败：Maximum call stack size exceeded」**。
  `peekRoot` → `resolveCurrentProblem` → `resolveProblemFromPanel` → `peekRoot` 构成相互递归，
  在「预览面板里有题目」且「没设 `pta.workspaceRoot`」时无限递归下去。
  刚登录、还没建过代码的用户一打开题目预览就会踩到（侧边栏刷新走的也是 `peekRoot`，同样中招）。
  现在 `resolveCurrentProblem` / `peekRoot` 带 `skipPanel` 参数把这条环路打断。
  新增回归测试：把 `vscode` 换成最小替身直接调真函数，**去掉守卫就会复现同样的 RangeError**。
- **已截止的题集显示「已截止」**，不再显示成「未开始 · 截止 2026-10-04」。
  PTA 对已经过期的题集有时仍然回 `PENDING`，光看 status 会自相矛盾。
  现在只要 `endAt` 已过去（或状态是 `END`）就只写「已截止」，也不再挂一个多余的日期。
- **「选择题集」下拉框不再漏出裸英文状态**（原来会显示成 `PENDING · 截止 …`），
  改为复用侧边栏那一套文案。

## [0.1.1] - 2026-10-09

### 修复

- **不再可能清空你已有的 `.vscode/tasks.json`**。原先写入前用
  `try { JSON.parse(...) } catch { /* 没有就新建 */ }` 读现有文件，
  而 VS Code 的 `tasks.json` 允许写注释 —— 一旦文件里有注释或尾随逗号，
  解析失败会被当成「文件不存在」，你原有的任务就被整份覆盖掉了。
  现在解析失败一律**只跳过写入**并提示，绝不新建覆盖；同时保留原文件的缩进
  （不会再把你 4 空格的排版改成 2 空格），`inputs` 等其它顶层键也不再丢失。
  逻辑抽到 `src/taskFile.js`，带回归测试。
- **`PTA Build` / `PTA Run Sample` 任务不再因缺目录而失败**。任务把产物写到
  `<题目目录>/.pta-build/`，而这个目录原先只在面板上跑过一次「运行样例」后才会创建，
  于是建完题直接跑任务，g++ 只会回一句 `No such file or directory`。
  现在写任务时会一并建好目录。
- **Windows 上任务显式使用 `cmd.exe`**。`type: "shell"` 且不指定 shell 时，
  VS Code 用默认终端 profile；默认是 Windows PowerShell 时，
  命令里的 `&&` 与输入重定向 `<` 都不是合法语法，任务会直接报错。
  现在 Windows 上固定 `cmd.exe`（与 xmuoj 插件、`.vscode-cpp-template` 一致），
  其它平台沿用默认 shell。

### 变更

- readme 里的安装示例文件名写的是 `pta-notebook-0.1.0.vsix`，
  与打包产物 `pta-toolkit-<version>.vsix` 不符，已改正。

## [0.1.0] - 2026-10-04

首个版本，可日常使用。

### 新增

- **题目预览面板**：点侧边栏的题目，在编辑器旁打开渲染好的题面（Markdown 标题 / 表格 /
  围栏代码块 / `$…$` 与 `$$…$$` 公式、图片、引用），带题目信息徽章与操作按钮。
  主按钮随本地状态在「创建代码」和「打开代码」之间切换；面板顶部显示当前题解目录，
  未设置时可直接点「更改」。题面优先读本地 `problem.md`，没有才请求 PTA。
- **拉取题集到本地**：支持「我的题集」（含老师布置的）、公开题集，以及直接粘贴题目链接。
  每题一个文件夹，结构与 XMUOJ 插件保持一致。
- **本地文件生成**
  - `problem.md`：题面（含输入 / 输出格式、样例、时限、内存、在线地址）
  - `samples/{n}.in` / `{n}.out`：样例输入输出
  - `.pta.json`：元数据（题目 ID / 语言 / 源文件名 / 时限 / 链接 / 做题状态）
  - 源码文件：C / C++ / Python / Java 四种内置最小模板，也支持用 `pta.templateDir` 指定自己的模板
  - `notes.md`：Obsidian 友好的笔记骨架（YAML frontmatter）
  - `index.md`：题集索引，含题号 / 标题 / 类型 / 分值 / 做题状态 / 本地链接
- **不覆盖规则**：`problem.md` 与 `samples/` 每次刷新重写；
  **源码文件与 `notes.md` 只在缺失时创建，永不覆盖**；`index.md` 中「我的备注」一节刷新时保留。
- **侧边栏**：活动栏「PTA」视图（我的题集 / 收藏夹 / 公开题集 → 题集 → 题目），
  题目列表按需加载并缓存，题目带 AC / WA 状态图标（跟随主题配色），
  右键可拉取 / 收藏 / 查看提交记录 / 在浏览器打开。
- **登录**
  - 微信扫码登录：在 VS Code 里画出二维码，扫码后扩展自动调 TokenLogin 换回 Cookie
  - 粘贴 Cookie 登录：从浏览器复制 `PTASession` 即可，接受裸值或整条 Cookie
  - Cookie 存在 VS Code SecretStorage（加密存储），不写配置文件、不进 Git
- **笔记**
  - 兼容 pintia 插件的 `@pintia note` / `@pintia test` / `@pintia code` 三种注释块
  - 命令「把源码里的笔记同步到 notes.md」，同步区用 marker 隔离，不影响手写内容
  - 代码片段：输入 `ptanote` / `ptatest` / `ptacode` 快速插入
- **本地跑样例**：编译 + 用样例输入运行 + 逐样例对比输出，结果写进输出通道。
  受 `pta.enableLocalTest` 开关控制（默认关），开启时同时写 `.vscode/tasks.json` 任务。
- **提交与测试**
  - 提交到 PTA 并每秒轮询判题结果，状态翻译成中文，逐测试点显示耗时 / 内存 / 得分
  - 在线测试：用自定义测试数据（本地样例 / `@pintia test` 块 / 手输 / 选文件）在 PTA 上跑一次，不计成绩
  - 查看这道题的最近一次提交
  - 查看这道题的提交记录：时间倒序列出最近若干条（状态 / 得分 / 耗时 / 内存 / 编译器），
    选一条看详情。接口 `GET /api/problem-sets/{psID}/submissions`，游标分页
    （`before` + `hasBefore`）；PTA 会忽略按题过滤的参数，所以是在本地筛的
- **检索与状态**
  - 收藏夹（`.pta-favorites.json`，写在题解工作区里，跟着 Git 走）
  - 跨题集搜索：首次建立索引后可输入关键词过滤，可中断、可重建
  - 做题状态：`PTA: 刷新题集的做题状态` 一次请求更新整个题集，
    写回各题 `.pta.json` 并重建索引；`index.md` 增加「状态」列（AC / WA / -）
  - `PTA: 每日签到`
- **交互与其他**
  - 源码顶部 CodeLens：提交 / 在线测试 / 跑本地样例 / 同步笔记 / 打开题面
  - 状态栏显示登录状态，点击直接进「我的题集」
  - `PTA: 诊断（导出原始 JSON）`：接口疑似变更时导出原始响应便于排查

### 修复

开发期间实测发现并修掉的问题（首个发布版本已不含这些缺陷）：

- **含空格的路径会让 `.vscode/tasks.json` 的任务失败**。任务是以 `type: "shell"` +
  整条命令字符串交给 shell 执行的，而命令里的路径原先没加引号，于是
  `…/练习2-1-Programming in C is fun!/main.cpp` 会在空格处被拆断，报
  `fatal error: fun!/main.cpp: No such file or directory`。
  PTA 上英文标题带空格很常见，属于高频问题。现在由 `src/compilers.js` 的
  `shellQuote` / `joinCommand` 统一处理：只含安全字符的参数保持原样，
  含空格或 shell 元字符（`& | $ \` ( )` 等）的加双引号；
  `spawn` 直传的 `args` 数组**不加**引号，两条路径互不污染。
- **提交记录的耗时 / 内存单位换算错了**。PTA 提交记录里的 `time` 是**秒**、
  `memory` 是**字节**，而题目里的 `timeLimit` / `memoryLimit` 才是毫秒 / KB。
  早期实现直接按 ms / KB 显示，数字会差 1000 倍。现统一由 `src/submit.js` 的
  `formatTime` / `formatMemory` 换算。
- **Windows 保留设备名未处理**：`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`
  （含 `CON.txt` 这类带扩展名的形式）会让建目录直接失败。现在会补一个 `_`。
  默认的 `{label}-{title}` 格式带题号前缀不会触发，属于兜底。
- **401 没被当成登录失效**：题集无权限时 PTA 返回 406，而做题状态、签到、
  提交历史这些需要登录的接口返回 401。早期只处理了 406，导致 401 被报成普通 HTTP 错误。
- **`@pintia note` 块里的注释前缀没剥掉**，同步进笔记时会带上 ` * `。
- **预览面板的题面标题重复**：面板顶部已显示标题，题面文件开头的同名 h1 会被剥掉；
  段落中间的 `$$…$$` 按行内渲染，避免块级公式把段落切断。

### 安全

- 登录凭证只存在 VS Code 的 SecretStorage（系统加密存储）中，
  不写入 `settings.json`、不写入工作区文件、不进 Git。
- 预览面板渲染题面时先整体转义再还原受控元素，题面里的 HTML 不会被执行；
  Webview 的 CSP 只放行 `https:` 图片与 CDN 上的 MathJax。

[Unreleased]: https://github.com/Woo3aN/pta-toolkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Woo3aN/pta-toolkit/releases/tag/v0.1.0
