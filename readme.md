# PTA Toolkit for VS Code

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.88.0-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#实现说明)

> 把拼题A（PTA / pintia.cn）的题目拉进 VS Code：**每题一个文件夹**，
> 在编辑器里看题面、写代码、跑样例、提交判题，笔记直接进 Obsidian。

零依赖、免编译的 VS Code 扩展 —— 不用 `npm install`，改代码也不用构建，`F5` 直接调试。

## 功能特性

| 能力 | 说明 |
|---|---|
| **题目预览面板** | 点题目在编辑器里看渲染好的题面（含公式、表格、代码块），一个按钮创建代码 |
| **侧边栏** | 活动栏里的题目集树，展开即见题目，带 AC / WA 状态图标 |
| **拉取题目** | 我的题集（含老师布置的）/ 公开题集 / 直接粘贴题目链接 |
| **本地文件** | `problem.md` 题面、`samples/{n}.in\|out` 样例、源码、`.pta.json` 元数据 |
| **跑样例** | 用 **PTA 评测机的原编译参数**本地编译运行，逐样例对比输出 |
| **提交判题** | 提交并轮询结果，状态翻译成中文；自定义数据在线测试（不计分）；提交记录可查 |
| **笔记** | `notes.md`（Obsidian 友好）+ 兼容 pintia 的 `@pintia note` 注释块 |
| **检索** | 收藏夹、跨题集搜索、题集索引（含 AC 状态） |
| **其他** | 微信扫码登录、每日签到、接口诊断 |

**不覆盖原则**：`problem.md` 与 `samples/` 每次刷新重写；
**源码文件与 `notes.md` 只在缺失时创建，永不覆盖**。

## 环境要求

| 项目 | 要求 |
|---|---|
| VS Code | `^1.88.0`（本机在 1.113.0 上验证） |
| 操作系统 | Windows / macOS / Linux（中文路径已在 Windows + MinGW 上逐项实测） |
| Node.js | **不用装** —— 扩展跑在 VS Code 自带的运行时里 |
| 依赖包 | **没有** —— 零依赖、免编译 |
| 编译器 | 仅「本地跑样例」需要：C/C++ 需 `g++` / `gcc`，Python 需 `python3`，Java 需 JDK |

只做导出与笔记的话，除了 VS Code 不需要额外安装任何东西。

## 安装

```bash
code --install-extension pta-toolkit-0.3.0.vsix
```

也可以在 VS Code 扩展面板右上角 `...` → 从 VSIX 安装。
开发调试则用 VS Code 打开本目录按 `F5`，**无需编译**。

## 快速开始

1. `PTA: 登录` —— 推荐**微信扫码**，不用复制任何东西
2. 点侧边栏里的任意题目 → 打开**题目预览面板** → 点「创建代码」
   （此时会让你选一次题解目录，之后记住不再问）
3. 在生成的源码文件里写代码，用 CodeLens 或面板按钮**运行样例** / **提交**
4. 需要整理笔记时看 `notes.md`，全部题目见题集下的 `index.md`

## 使用

### 侧边栏

点活动栏（最左侧图标条）的 **PTA** 图标，就是题目集树 —— 相当于把
[pintia.cn/problem-sets/active](https://pintia.cn/problem-sets/active) 搬进 VS Code：

```text
我的题集     展开是你的题目集 → 再展开看题目（题目右侧显示 AC / WA）
收藏夹       本地收藏的题目
公开题集     无需登录即可浏览
```

| 操作 | 效果 |
|---|---|
| **点击题目** | 打开**题目预览面板**（本地已有则按钮变成「打开代码」） |
| 悬停题目的按钮 | 一键拉取到本地 |
| 右键题目 | 预览 / 收藏 / 查看提交记录 / 在浏览器中打开 |
| 右键题集 | 拉取整个题集、刷新做题状态 |
| 标题栏 | 刷新列表、搜索题目、**选择题解目录**、登录 / 退出 |

题目列表按需加载（展开题集时才请求），一次会话内缓存。
状态图标用编辑器自带的「测试通过 / 失败」配色，自动跟随主题。

### 题目预览面板

在侧边栏点一道题，就会在编辑器旁开一个面板：渲染好的题面（Markdown 表格、围栏代码块、
公式）、题目信息、一排操作按钮。面板的题面直接读本地 `problem.md`（生成的包装会剥掉，
避免和面板自己的信息重复）；「刷新题面」会回 PTA 重新拉取并重写该文件。

题目信息与 `problem.md` 共用同一套布局（`src/problemInfo.js`）：顶部一行是时限与内存，
末尾「详细信息」是题集 / 题型 / 分值 / 作者 / 在线地址 / 本地抓取；徽章只留本地状态
（做题状态 / 语言 / 源码文件）。

```
[创建代码]  ← 本地没有代码时显示这个
[打开代码]  ← 本地已有代码时显示这个（不覆盖你的代码）
[打开题面] [运行样例] [切换语言] [同步笔记]   ← 有本地工作区时才出现
[提交到 PTA] [在线测试] [浏览器打开] [刷新题面]
```

面板顶部会显示当前**题解目录**，没有设置时给出提示并可以直接点「更改」——
这也是设置生成路径的入口之一。

题面优先读本地 `problem.md`（快，且与磁盘内容一致）；本地还没有时才请求 PTA，
所以点开一道新题也能先看题面再决定要不要创建文件。

### 命令

按 `Ctrl+Shift+P`（macOS 为 `Cmd+Shift+P`）输入 `PTA` 即可看到全部命令。

**登录**

| 命令 | 说明 |
|---|---|
| `PTA: 登录` | 选择登录方式 |
| `PTA: 微信扫码登录` | 在 VS Code 里显示二维码，扫码即完成登录 |
| `PTA: 粘贴 Cookie 登录` | 从浏览器复制 `PTASession` 粘贴进来 |
| `PTA: 退出登录` | 清除本地登录态 |

**浏览与导出**

| 命令 | 说明 |
|---|---|
| `PTA: 预览题目（题面 + 创建代码）` | 打开题目预览面板（侧边栏点击题目的同一动作） |
| `PTA: 从链接拉取（题目 / 题集）` | 会自动读剪贴板；带题目 ID 就只拉这一道 |
| `PTA: 拉取我的题集` | 你的题集（含老师布置的） |
| `PTA: 浏览公开题集` | 公开题集，无需登录 |
| `PTA: 刷新题目集列表` | 重新加载侧边栏 |
| `PTA: 刷新当前题目的题面与样例` | 只更新题面与样例，代码和笔记不动 |
| `PTA: 打开题集索引` | 打开题集的 `index.md` |

**写代码与笔记**

| 命令 | 说明 |
|---|---|
| `PTA: 打开当前题面` | 在侧栏打开 `problem.md` |
| `PTA: 打开本地题目文件` | 直接打开题目目录里的源码 / 题面文件 |
| `PTA: 切换 / 新建解题语言` | 一题可同时留多种语言的代码 |
| `PTA: 把源码里的笔记同步到 notes.md` | 抽取 `@pintia note` 块 |
| `PTA: 运行当前题目的样例` | 本地编译 + 跑样例 + 对比输出 |

**提交与查询**

| 命令 | 说明 |
|---|---|
| `PTA: 提交当前文件到 PTA` | 正式提交，计入成绩 |
| `PTA: 在线测试当前文件` | 用自定义数据在 PTA 上跑一次，不计分 |
| `PTA: 查看这道题的最近一次提交` | 最近一次提交的状态 / 得分 / 耗时 / 内存 |
| `PTA: 查看这道题的提交记录` | 时间倒序列出这道题的提交记录，选一条看详情 |
| `PTA: 刷新题集的做题状态` | 一次请求更新整个题集的状态并重建索引 |

**检索与收藏**

| 命令 | 说明 |
|---|---|
| `PTA: 搜索题目` | 跨「我的题集」搜索，输入关键词过滤 |
| `PTA: 刷新题目索引` | 重建搜索索引 |
| `PTA: 收藏 / 取消收藏当前题目` | 本地收藏夹（跟着 Git 走） |
| `PTA: 打开收藏夹` | 列出收藏的题目 |

**工作区与其他**

| 命令 | 说明 |
|---|---|
| `PTA: 选择工作区根目录` | **设置题目生成到哪个目录**（侧边栏标题栏也有按钮） |
| `PTA: 打开题解工作区` | 在新窗口打开题解目录 |
| `PTA: 每日签到` | PTA 教育商店签到 |
| `PTA: 诊断（导出原始 JSON）` | 接口疑似变更时导出原始响应 |

源码顶部还有一行 CodeLens：提交 / 在线测试 / 跑本地样例 / 同步笔记 / 打开题面。

### 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `pta.workspaceRoot` | 空 | 题解工作区根目录，留空时首次拉取会弹框选择 |
| `pta.defaultLanguage` | `C++` | 新建题目默认语言（C++ / C / Python / Java） |
| `pta.autoCreateSource` | `true` | 是否自动创建源码文件 |
| `pta.createNotesFile` | `true` | 是否创建 `notes.md` |
| `pta.codeNotes` | `false` | 在新建源码里放一个 `@pintia note` 块（会随代码一起提交到 PTA）。默认关闭，笔记建议直接写在 Obsidian |
| `pta.templateDir` | 空 | 自定义模板目录（放自己的 `main.cpp` 等），留空用内置最小模板 |
| `pta.enableLocalTest` | `false` | 开启后写 `.vscode/tasks.json` 任务并支持本地跑样例 |
| `pta.pythonPath` | 空 | 指定 Python 解释器，留空自动探测 |
| `pta.requestInterval` | `600` | 连续请求间隔（毫秒），防限流 |
| `pta.fileNameFormat` | `{label}-{title}` | 题目文件夹命名，可用 `{label}` `{title}` `{pid}` |
| `pta.includeNonProgramming` | `false` | 是否也拉函数题（`CODE_COMPLETION`） |

**题目生成到哪**：优先看 `pta.workspaceRoot`；没设置时，第一次点「创建代码」或执行
拉取命令会弹出目录选择框，选完写回配置（全局），之后不再问。
选错了就再执行一次 `PTA: 选择工作区根目录`，或在设置里直接改这个值。
如果误选了某个题集子目录，会自动回退到它的根目录并提示。

## 目录结构

```
{工作区根目录}/
├── .pta-favorites.json          收藏夹（跟着 Git 走）
├── .pta-search-index.json       搜索索引缓存（可重新生成）
└── problem-sets/
    └── {题集ID}-{题集名}/
        ├── index.md             题集索引：「我的备注」一节不会被刷新覆盖
        └── {题号}-{标题}/
            ├── problem.md       题面 + 样例（每次刷新重写，别手改）
            ├── notes.md         笔记（只在缺失时创建）
            ├── main.cpp         源码（只在缺失时创建）
            ├── .pta.json        元数据：题目 ID / 语言 / 时限 / 做题状态
            └── samples/1.in 1.out
```

沿用 [XMUOJ 插件](https://github.com/AndyLishengrui/xmuoj) 的本地工作区约定
（`problem.md` + `samples/{n}.in|out` + 隐藏的元数据 JSON + 源码不覆盖 +
把编译 / 运行命令写进 `.vscode/tasks.json`），两个平台的习惯可以复用。

## 命名规则

| 项目 | 规则 |
|---|---|
| 题集目录 | `{题集ID}-{题集名}`，题集名截断到 50 字符 |
| 题目目录 | `{题号}-{标题}`，默认截断到 70 字符；格式可用 `pta.fileNameFormat` 改成 `{label}` / `{title}` / `{pid}` 的任意组合 |
| 固定文件 | `problem.md`、`notes.md`、`index.md`、`.pta.json`、`samples/{n}.in` / `{n}.out` |
| 源码文件 | 按语言：`main.cpp` / `main.c` / `main.py` / `Main.java` |
| 编译产物 | 收在 `.pta-build/`（已在 `.gitignore` 中忽略） |

**命名做了这些处理：**

- **中文原样保留**，不转拼音、不转义。
- Windows 非法字符 `\ / : * ? " < > |` → 替换成 `-`。
- 首尾的点和空格去掉（Windows 不允许目录名以 `.` 或空格结尾）。
- 控制字符去掉；连续空白压缩成一个空格。
- 超长按上限截断。
- 撞上 Windows 保留设备名（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`，含带扩展名的形式）时补一个 `_`。
  默认格式带题号前缀，实际不会触发；只有把格式改成纯 `{title}` 才需要在意。
- 题号唯一，所以不需要处理重名。

**中文路径实测结论**（本机 Windows + MinGW，逐项跑过）：

| 场景 | 结果 |
|---|---|
| 创建 / 读写中文目录与文件 | 正常 |
| 中文路径下 `g++` 编译 + 运行 | 正常 |
| 中文路径下 Python 运行，且**输出中文与样例比对** | 正常 |
| `git add` / `commit` / `checkout` 中文路径 | 正常 |
| 写进 `.vscode/tasks.json` 的任务命令 | 正常（路径按需加引号） |

两个已知的显示层现象（都不影响文件本身）：

- `git status` / `git ls-files` 默认把非 ASCII 路径转义成 `\346\265\231...`（八进制 UTF-8）。
  想看原始路径用 `git -c core.quotePath=false ls-files`。
- 若整个路径超过 Windows 的 260 字符上限（很深的根目录 + 长题名），可能建不出文件。
  这是 Windows API 的限制，不是编码问题；开启系统的长路径支持即可。

## 笔记

两种记法，可同时使用：

1. **`notes.md`** —— 主笔记，拉取时生成骨架（YAML frontmatter + 题意 / 思路 / 边界易错点 /
   复杂度 / 代码），之后**永不被覆盖**。放进 Obsidian 库就是一篇可双链的笔记。
2. **源码里的 `@pintia note` 块**（`pta.codeNotes`，默认关闭）—— 与 pintia 插件兼容，
   **会随代码一起提交到 PTA**：

   ```cpp
   /* @pintia note=start
    * 前缀和 + 二分，注意边界取等号
    * @pintia note=end */
   ```

   用内置模板新建源码时，会在**文件末尾**留一个空的 note 块（不挡着第一眼就看代码）；
   用 `pta.templateDir` 指定自己的模板时插件不插手。

执行 `PTA: 把源码里的笔记同步到 notes.md` 会把这块内容同步进笔记，
同步区用 marker 隔离，手写内容不受影响。

代码片段前缀：`ptanote` / `ptatest` / `ptacode`。

**提交哪段代码**：写了 `@pintia code=start/end` 就只提交块内那段，否则提交整个文件。

## 登录

PTA 的登录态是一个名为 `PTASession` 的 Cookie。三种获取方式：

| 方式 | 说明 |
|---|---|
| **微信扫码**（推荐） | 扩展自己把授权链接编码成二维码显示在 VS Code 里，扫完自动换回 Cookie |
| **粘贴 Cookie** | 兜底，永远可用。浏览器登录 pintia.cn → `F12` → `Application` → `Cookies` → 复制 `PTASession` |
| 账号密码 | **不可用**，见[常见问题](#常见问题) |

二维码不由微信页面渲染：那条链接是公众号 OAuth 链接，在桌面浏览器打开会直接报错，
所以扩展只把链接画成码，再轮询状态、调 TokenLogin 取回 `Set-Cookie`。

Cookie 保存在 VS Code 的加密存储（SecretStorage）：**不写配置文件、不进 Git、不落明文**。
扫码和粘贴 Cookie 都不需要把密码交给插件。

> Cookie 会过期（通常几天到几周）。过期后重新登录一次即可。

## 常见问题

**题目生成到哪个目录？怎么改？**
三种入口，效果一样：① 侧边栏标题栏的目录按钮；② 命令 `PTA: 选择工作区根目录`；
③ 设置里的 `pta.workspaceRoot`。首次创建代码时也会弹一次让选，选完就记住了。

**点题目只是预览，文件在哪？**
预览面板不会写任何文件。点面板上的「创建代码」才会生成目录与文件，
并顺手打开源码文件。

**提示 406 或要求重新登录？**
Cookie 失效了，重新登录即可。

**老师布置的题集拉不到？**
这类题集需要登录态，先登录；若提示权限问题，确认题集已开始且你已加入。

**为什么不能用账号密码登录？**
PTA 给登录接口加了腾讯图形验证码，不带验证码请求 `POST /api/users/sessions` 会直接返回
`GATEWAY_WRONG_CAPTCHA`，插件里嵌不了那套组件。请用扫码或 Cookie。

**提交报「自己创建的题集」？**
PTA 不为这类题集创建考试容器，因此无法提交。导出题面与笔记不受影响。

**题面里的公式显示成原始的 `\(…\)` 或 `$$…$$`？**
面板用内置的 MathJax（`vendor/mathjax/`）渲染，不联网。如果仍然显示原始 LaTeX，
多半是打包时把 `vendor/mathjax/` 漏掉了（会退回 CDN，一旦网络拦掉就不渲染）。

**样例是空的？**
有些题本身没有样例（例如无输入的题），PTA 返回空数组属正常。

**跑样例提示找不到编译器？**
本机需有 `g++` / `gcc` / `python`（Java 需 JDK）。Python 找不到时可在设置里填 `pta.pythonPath`。

**有提交记录可看吗？**
有。`PTA: 查看这道题的提交记录` 会按时间倒序列出这道题最近的若干条提交
（状态 / 得分 / 耗时 / 内存 / 编译器），选一条看详情。

接口是 `GET /api/problem-sets/{psID}/submissions`，游标分页（`before` + `hasBefore`）。
两个已实测的坑：PTA 会**忽略按题过滤的参数**，所以「某道题的记录」是取回整个题集的记录后在本地筛；
这个接口里 **`time` 单位是秒、`memory` 单位是字节**（题目里的 `timeLimit` / `memoryLimit` 才是 ms / KB）。

**接口变了怎么办？**
执行 `PTA: 诊断` 导出原始响应，对照 `src/ptaApi.js` 调整 —— 那是唯一需要改的文件。

## 已知限制

| 限制 | 说明 |
|---|---|
| 题型覆盖 | 只导出有结构化题面 / 样例的题型（编程题、函数题）。判断题、选择题不导出 |
| 隐藏测试点 | 只能拿到题面公开的样例（`exampleTestDatas`），隐藏测试点 PTA 不给 |
| 考试型题集 | 带考试入口 / 考试密码的题集路径与普通作业题集不同，暂未专门适配 |
| 公式与插图 | 公式本身若是远程图片，则保留链接而不下载到本地；面板用内置的 MathJax 渲染公式，不联网 |
| 账号密码登录 | 不可用，原因见[常见问题](#常见问题) |
| 提交范围 | 自己创建的题集（PTA 侧权限值 47）无法提交 |
| 文件名 | 默认保留中文、不转拼音，格式可用 `pta.fileNameFormat` 自行调整 |
| 路径长度 | 整个路径超过 Windows 的 260 字符上限时可能建不出文件，需开启系统的长路径支持 |

PTA 随时可能改接口。所有端点都集中在 `src/ptaApi.js`，真出问题时只改这一个文件。

## 实现说明

- **零依赖、免编译**：HTTP 用 Node 内置 `https`，压缩用内置 `zlib`，打包 vsix 用 Python 标准库
  `zipfile`。唯一内联的第三方代码是生成二维码的 `qrcode-generator`。
- **认证只要 Cookie**：请求头仅需 `Cookie: PTASession=…` +
  `Accept/Content-Type: application/json;charset=UTF-8` + `Accept-Language: zh-CN`，
  不需要 `x-lollipop` 之类的动态签名。未登录时 PTA 返回 **401**（需登录的接口）
  或 **406**（题集无权限），插件据此提示重新登录。
- **题面直接是 Markdown**：含 `### 输入格式:` 这类小标题，公式是 `$$…$$` 行内标记，
  不需要 HTML→Markdown 转换；少数含插图的题才走轻量转换兜底。
  预览面板自带一个极简 Markdown 渲染器（`src/markdown.js`），先摘出代码块与公式再整体转义，
  避免题面里的 `<` `&` 破坏版面。
- **编译参数照抄 PTA 评测机**（`src/compilers.js`）：
  `g++ -DONLINE_JUDGE -fno-tree-ch -O2 -Wall -std=c++17 -pipe $src -lm -o $exe`。
  `-DONLINE_JUDGE` 会改变很多竞赛模板的行为，漏掉就会出现「本地过、提交挂」。
- **写入 `.vscode/tasks.json` 的任务**（`src/taskFile.js`）：路径按需加引号
  （标题里的空格会拆断参数）；Windows 上显式用 `cmd.exe`（默认的 PowerShell 不认
  `&&` 和输入重定向 `<`）；写任务前先建好 `.pta-build/`（g++ 不会自己建目录）。
  合并时**解析不了就整个跳过，绝不新建覆盖** —— `tasks.json` 允许写注释，
  早先把「有注释」误判成「文件不存在」，会把用户已有的任务清掉。
- **索引从磁盘生成**：`index.md` 由各题 `.pta.json` 汇总而来，永远与本地实际文件一致。
- **单位别猜**：PTA 提交记录里的 `time` 是**秒**、`memory` 是**字节**，
  题目里的 `timeLimit` / `memoryLimit` 才是**毫秒 / KB**。
  换算统一放在 `src/submit.js` 的 `formatTime` / `formatMemory`，并有测试守着。
- 接口集中在 `src/ptaApi.js`，常量在 `src/compilers.js`，
  纯逻辑（命名、Markdown、面板 HTML、树节点展示）都不依赖 `vscode`，所以能单测。

## 开发

```bash
# 调试：VS Code 打开本目录，按 F5（无需编译）
# 打包并安装
python tools/build-vsix.py
code --install-extension pta-toolkit-0.3.0.vsix --force
```

测试：

```bash
node test/offline.js             # 离线 375 项：目录命名、不覆盖规则、笔记同步、编译器命令、
                                 #   真跑样例、二维码、Set-Cookie、收藏夹、做题状态、侧边栏节点、
                                 #   提交报告、Markdown 渲染、预览面板 HTML、tasks.json 合并、
                                 #   题集「已截止」文案、面板↔根目录的递归回归、公式行内渲染、
                                 #   内置模板与题集权限提示、题面信息安排、面板字号、面板↔题面信息一致
node test/e2e-panel.js 12 2      # 实网：用真实题面渲染预览面板
node test/e2e-auth.js            # 实网：登录链路的端点契约与错误语义（无需账号）
node test/e2e-public.js 12       # 实网：题面与样例确实能拉到（无需登录）
node test/pull-real.js 12 2      # 实网：完整走一遍拉取并生成本地文件夹
node tools/check-consistency.js  # 核对 package.json / extension.js / readme 三方是否一致
```

`test/offline.js` 里的「真跑一遍本地样例」会真的调 `g++` 编译运行（在含空格与中文的目录里），
用来保证编译参数和路径引号没被改坏。

`tools/check-consistency.js` 是为了防止文档漂移：它检查每个命令是否都注册了、
菜单与视图引用是否有效、readme 命令表与配置表是否与实现一一对应。
（起因是 readme 曾写出「本插件不支持提交和测试」这类与实现相反的话。）

## 更新日志

各版本的变更记录见 [CHANGELOG.md](CHANGELOG.md)，
结构遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 致谢

- **[jinzcdev/vscode-pintia](https://github.com/jinzcdev/vscode-pintia)**（MIT）
  —— PTA 接口逆向的主要参考。接口路径、请求头与错误语义、提交与自定义测试的完整流程、
  判题状态中文名、题型与编译器代码映射、`@pintia note` 笔记块机制、
  以及 `src/compilers.js` 里那套评测机原始编译命令，均来自阅读它的源码。

  两者功能重叠很多：登录、侧边栏浏览题目集、题目搜索、收藏、签到、提交、在线测试、
  笔记（`@pintia note` 块），本插件都有，它也有。它比本插件多出来的是：
  题目预览历史、官方题解查看与检索、按需清理缓存、文件名中文转拼音、
  搜索索引默认覆盖公开题集（含 ZOJ）。

  **本插件与它最实质的差别**：本插件把题面和样例**落成文件**
  （`problem.md` + `samples/{n}.in|out` + `notes.md`，每题一个文件夹，可直接丢进 Obsidian 双链），
  它则是把题面放在 Webview 里预览、一题一个源文件。
  所以「导出成本地笔记」这件事用本插件；两边的工作区目录互不干扰
  （它默认写 `$HOME/.pintia/codes`，本插件用 `pta.workspaceRoot`），同时装也不冲突，
  只是要各登录一次。
- **[AndyLishengrui/xmuoj](https://github.com/AndyLishengrui/xmuoj)**
  —— 本地工作区约定来自它：`problem.md` + `samples/{n}.in|out` + 隐藏元数据 JSON +
  源码不覆盖 + 把编译 / 运行命令写进 `.vscode/tasks.json`。
  题目预览面板的交互（主按钮在「创建代码 / 打开代码」之间切换）也照它的做法。

登录接口清单（`/api/users/sessions`、`/api/users/mfa/…`、`TokenLogin` 等）与编译器表
来自 PTA 自己前端 bundle 里的接口定义，非猜测。实测记录见 `src/ptaApi.js` 文件头注释。

### 第三方代码

| 组件 | 许可 | 用途 |
|---|---|---|
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 | MIT | 把微信授权链接编码成二维码 |
| [MathJax](https://www.mathjax.org/) 3 | Apache-2.0 | 渲染题面里的 LaTeX 公式（`vendor/mathjax/tex-svg.js`） |

以源码内联方式引入（`vendor/qrcode.js`），以保持「零依赖、免编译」。
详见 `vendor/THIRD-PARTY-NOTICES.md`。

## 贡献

欢迎提 Issue 与 PR。改动前请先跑一遍：

```bash
node tools/check-consistency.js && node test/offline.js
```

改了命令、配置或行为，记得同步更新 `readme.md` 与 `CHANGELOG.md` —— 一致性脚本会检查这件事。

## 许可

[MIT](LICENSE)
