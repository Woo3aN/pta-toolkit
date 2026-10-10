"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const api = require("./src/ptaApi");
const auth = require("./src/auth");
const ws = require("./src/problemWorkspace");
const library = require("./src/library");
const notes = require("./src/notes");
const runner = require("./src/runner");
const submit = require("./src/submit");
const submissions = require("./src/submissions");
const templates = require("./src/templates");
const taskFile = require("./src/taskFile");
const { PtaCodeLensProvider } = require("./src/codeLens");
const { WechatLoginPanel } = require("./src/loginPanel");
const { ProblemPanel, buildPanelHtml, renderPanelSkeleton } = require("./src/problemPanel");
const { PtaTreeDataProvider, VIEW_ID: TREE_VIEW_ID } = require("./src/tree");
const treeModel = require("./src/treeModel");

const SECRET_COOKIE = "pta.session.cookie";
const STATE_USER = "pta.user";
const DIAGNOSE_DIR = "_pta-diagnose";
const OUTPUT_NAME = "PTA Toolkit";

let outputChannel;
let statusBarItem;
let extensionContext;
let activeLoginPanel;
let treeProvider;
let problemPreview;

/**
 * 预览面板当前显示的题目。编辑器不在题目目录里时（例如焦点在面板上），
 * 各命令靠它回退，这样「运行样例 / 提交 / 切语言」在面板里点也能找到题目。
 */
let panelProblemRef = null;

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

function log(message) {
  if (!outputChannel) {
    return;
  }
  outputChannel.appendLine(`[${ws.timestampForFile()}] ${message}`);
}

async function exists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch (_error) {
    return false;
  }
}

function getSettings() {
  const config = vscode.workspace.getConfiguration("pta");
  return {
    workspaceRoot: String(config.get("workspaceRoot", "") || "").trim(),
    language: templates.normalizeLanguage(config.get("defaultLanguage", "C++")),
    autoCreateSource: config.get("autoCreateSource", true) !== false,
    createNotesFile: config.get("createNotesFile", true) !== false,
    templateDir: String(config.get("templateDir", "") || "").trim(),
    enableLocalTest: config.get("enableLocalTest", false) === true,
    pythonPath: String(config.get("pythonPath", "") || "").trim(),
    requestInterval: Number(config.get("requestInterval", 600)) || 0,
    fileNameFormat: String(config.get("fileNameFormat", "{label}-{title}") || "{label}-{title}"),
    includeNonProgramming: config.get("includeNonProgramming", false) === true
  };
}

async function updateSetting(key, value) {
  await vscode.workspace.getConfiguration("pta").update(key, value, vscode.ConfigurationTarget.Global);
}

async function getCookie(options) {
  const opts = options || {};
  const cookie = await extensionContext.secrets.get(SECRET_COOKIE);
  if (cookie) {
    return cookie;
  }
  if (opts.publicOnly) {
    return "";
  }
  const pick = await vscode.window.showWarningMessage(
    "这个操作需要先登录 PTA（老师布置的题集必须有登录态才能读取）。",
    "立即登录"
  );
  if (pick === "立即登录") {
    await commandLogin();
    return (await extensionContext.secrets.get(SECRET_COOKIE)) || null;
  }
  return null;
}

async function refreshStatusBar() {
  if (!statusBarItem) {
    return;
  }
  const cookie = await extensionContext.secrets.get(SECRET_COOKIE);
  await vscode.commands.executeCommand("setContext", "pta.signedIn", Boolean(cookie));
  if (!cookie) {
    statusBarItem.text = "$(sign-in) PTA: 未登录";
    statusBarItem.tooltip = "点击登录拼题A（粘贴 PTASession）";
    statusBarItem.command = "pta.login";
    statusBarItem.show();
    return;
  }
  const user = extensionContext.globalState.get(STATE_USER);
  statusBarItem.text = `$(account) PTA: ${user && user.user ? user.user : "已登录"}`;
  statusBarItem.tooltip = "点击打开「我的题集」；右键或命令面板可退出登录";
  statusBarItem.command = "pta.pullMyProblemSet";
  statusBarItem.show();
}

async function handleError(error, hint) {
  const message = error && error.message ? error.message : String(error);
  log(`[错误] ${error && error.stack ? error.stack : message}`);
  if (api.isAuthError(error)) {
    const pick = await vscode.window.showErrorMessage(message, "重新登录", "查看输出");
    if (pick === "重新登录") {
      await commandLogin();
    } else if (pick === "查看输出") {
      outputChannel.show();
    }
    return;
  }
  const pick = await vscode.window.showErrorMessage(hint ? `${hint}：${message}` : message, "查看输出");
  if (pick === "查看输出") {
    outputChannel.show();
  }
}

/* ------------------------------------------------------------------ */
/* 工作区根目录                                                        */
/* ------------------------------------------------------------------ */

/**
 * 用户可能选到 problem-sets / 题集目录 / 单题目录，
 * 这里统一往上回退出真正的根目录（和 xmuoj 的处理思路一致）。
 */
function normalizeRootSelection(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }
  let resolved = path.resolve(value);
  for (let depth = 0; depth < 4; depth += 1) {
    const base = path.basename(resolved);
    const parent = path.dirname(resolved);
    if (base === ws.PROBLEM_SET_DIR_NAME) {
      return parent;
    }
    if (path.basename(parent) === ws.PROBLEM_SET_DIR_NAME) {
      return path.dirname(parent);
    }
    break;
  }
  return resolved;
}

async function getWorkspaceRoot(options) {
  const opts = options || {};
  const settings = getSettings();
  const configured = settings.workspaceRoot;
  const normalized = normalizeRootSelection(configured);

  if (normalized && normalized !== configured) {
    await updateSetting("workspaceRoot", normalized);
  }
  if (normalized && !opts.forcePick && (await exists(normalized))) {
    return normalized;
  }

  let defaultUri;
  if (configured && (await exists(configured))) {
    defaultUri = vscode.Uri.file(configured);
  } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
    defaultUri = vscode.workspace.workspaceFolders[0].uri;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "选择题解工作区根目录",
    defaultUri
  });
  if (!picked || !picked.length) {
    return null;
  }
  const chosen = picked[0].fsPath;
  const fixed = normalizeRootSelection(chosen);
  if (path.resolve(chosen) !== fixed) {
    vscode.window.showInformationMessage(`已自动回退为工作区根目录：${fixed}`);
  }
  await updateSetting("workspaceRoot", fixed);
  return fixed;
}

/* ------------------------------------------------------------------ */
/* 生成一道题                                                          */
/* ------------------------------------------------------------------ */

/**
 * shell 任务的 options。
 *
 * `type: "shell"` 且不指定 shell 时，VS Code 用的是默认终端 profile。
 * Windows 上默认是 Windows PowerShell（本机没装 PS 7 就是 5.1），而命令里
 * 用到的 `&&` 和输入重定向 `<` 在 PowerShell 5.1 里都不是合法语法，
 * 任务会直接报「标记"&&"不是此版本中的有效语句分隔符」。
 * 所以 Windows 上显式钉成 cmd.exe，和 xmuoj 插件的做法、以及
 * `.vscode-cpp-template` 里的任务保持一致；其它平台沿用默认 shell。
 */
function shellTaskOptions() {
  const options = { cwd: "${workspaceFolder}" };
  if (process.platform === "win32") {
    options.shell = { executable: "cmd.exe", args: ["/d", "/c"] };
  }
  return options;
}

/** 合并 tasks.json 失败时只提醒一次，免得一口气拉 100 道题弹 100 个框。 */
let tasksWriteWarningShown = false;

async function writeTasksForProblem(root, problemDir, metadata, settings) {
  const vscodeDir = path.join(root, ".vscode");
  const tasksPath = path.join(vscodeDir, "tasks.json");
  await fs.promises.mkdir(vscodeDir, { recursive: true });

  // 任务把可执行产物写到 <题目目录>/.pta-build/，而 g++ 不会自己建目录。
  // 缺了它，只会回一句难懂的 "No such file or directory"。
  await fs.promises.mkdir(path.join(problemDir, runner.BUILD_DIR_NAME), { recursive: true });

  const relativeDir = path.relative(root, problemDir).split(path.sep).join("/");
  const commands = runner.buildTaskCommands({
    language: metadata.language,
    sourceFileName: metadata.sourceFile,
    relativeDir,
    pythonPath: settings.pythonPath
  });
  const key = `${metadata.label || metadata.problemId}-${metadata.language}`;

  const outcome = await taskFile.mergeTasksFile(
    tasksPath,
    [
      {
        label: `PTA Build ${key}`,
        type: "shell",
        command: commands.build,
        options: shellTaskOptions(),
        problemMatcher: []
      },
      {
        label: `PTA Run Sample ${key}`,
        type: "shell",
        command: commands.run,
        options: shellTaskOptions(),
        problemMatcher: []
      }
    ],
    { replaceKeys: [key] }
  );

  if (!outcome.ok) {
    // 常见原因是 tasks.json 里有注释（VS Code 允许）。这种情况绝不能当成
    // 「文件不存在」去新建 —— 那会把用户已有的任务整份清掉，所以这里只跳过。
    log(`没有写入 ${tasksPath}：${outcome.reason}`);
    if (!tasksWriteWarningShown) {
      tasksWriteWarningShown = true;
      vscode.window.showWarningMessage(
        `没把 PTA 任务写进 .vscode/tasks.json：${outcome.reason}。` +
          "你原有的任务没有被改动；修好这个文件的写法后重新拉取即可。"
      );
    }
    return null;
  }

  return tasksPath;
}

async function buildOneProblem(options) {
  const opts = options || {};
  const settings = opts.settings || getSettings();
  const root = opts.workspaceRoot;
  const detail = await api.getProblemDetail(opts.problemSetId, opts.problemId, opts.cookie || "");
  const result = await ws.ensureProblemWorkspace({
    workspaceRoot: root,
    problemSetId: opts.problemSetId,
    problemSetName: opts.problemSetName || "",
    problem: detail,
    language: settings.language,
    fileNameFormat: settings.fileNameFormat,
    templateDir: settings.templateDir,
    autoCreateSource: settings.autoCreateSource,
    createNotesFile: settings.createNotesFile,
    url: api.buildProblemUrl(opts.problemSetId, opts.problemId, detail.type),
    problemTypeName: api.problemTypeName(detail.type)
  });
  if (settings.enableLocalTest) {
    await writeTasksForProblem(root, result.problemDir, result.metadata, settings);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 拉取题集                                                            */
/* ------------------------------------------------------------------ */

async function selectProblems(problems) {
  const items = problems.map((problem) => ({
    label: `${problem.label || ""} ${problem.title || ""}`.trim(),
    description: `${api.problemTypeName(problem.type)}${problem.score === undefined ? "" : ` · ${problem.score} 分`}`,
    picked: true,
    problem
  }));

  if (items.length > 150) {
    const mode = await vscode.window.showQuickPick(
      [
        { label: `$(check-all) 全部拉取（${items.length} 道）`, value: "all" },
        { label: "$(list-selection) 逐个挑选", value: "pick" }
      ],
      { placeHolder: `这个题集有 ${items.length} 道题，怎么拉？` }
    );
    if (!mode) {
      return null;
    }
    if (mode.value === "all") {
      return problems;
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: "选择要拉取到本地的题目（默认全选）",
    matchOnDescription: true
  });
  if (!picked) {
    return null;
  }
  return picked.map((item) => item.problem);
}

async function pullProblemSet(problemSetId, problemSetName, options) {
  const opts = options || {};
  const settings = getSettings();
  const root = await getWorkspaceRoot({});
  if (!root) {
    return;
  }
  const cookie = opts.cookie === undefined ? await getCookie({}) : opts.cookie;
  if (cookie === null) {
    return;
  }

  let summaries;
  try {
    summaries = await api.getProblemSummary(problemSetId, cookie);
  } catch (error) {
    await handleError(error, "读取题集失败");
    return;
  }

  let types = Object.keys(summaries || {});
  if (!settings.includeNonProgramming) {
    const programming = types.filter((type) => type === "PROGRAMMING");
    if (programming.length) {
      types = programming;
    }
  }
  types = types.filter((type) => api.SAMPLE_BEARING_TYPES.indexOf(type) >= 0);
  if (!types.length) {
    vscode.window.showWarningMessage("这个题集里没有可导出题面和样例的编程题。");
    return;
  }

  let name = problemSetName || "";
  let problems = [];
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在读取题集「${name || problemSetId}」的题目列表…` },
      async () => {
        if (!name) {
          try {
            const info = await api.getProblemSetExams(problemSetId, cookie);
            name = (info && info.problemSet && info.problemSet.name) || "";
          } catch (_error) {
            name = "";
          }
        }
        for (const type of types) {
          const list = await api.getAllProblems(problemSetId, type, cookie, { interval: settings.requestInterval });
          problems = problems.concat(list);
        }
      }
    );
  } catch (error) {
    await handleError(error, "读取题目列表失败");
    return;
  }

  if (!problems.length) {
    vscode.window.showWarningMessage("这个题集没有读到题目。");
    return;
  }

  const selected = await selectProblems(problems);
  if (!selected || !selected.length) {
    return;
  }

  const failures = [];
  let created = 0;
  let refreshed = 0;
  let pulled = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `拉取「${name || problemSetId}」`,
      cancellable: true
    },
    async (progress, token) => {
      for (let index = 0; index < selected.length; index += 1) {
        if (token.isCancellationRequested) {
          break;
        }
        const problem = selected[index];
        progress.report({
          message: `${index + 1}/${selected.length}  ${problem.label || ""} ${problem.title || ""}`,
          increment: 100 / selected.length
        });
        try {
          const result = await buildOneProblem({
            workspaceRoot: root,
            problemSetId,
            problemSetName: name,
            problemId: problem.id,
            cookie,
            settings
          });
          if (result.createdSource) {
            created += 1;
          } else {
            refreshed += 1;
          }
          pulled += 1;
        } catch (error) {
          failures.push({ problem, message: error && error.message ? error.message : String(error) });
          log(`[跳过] ${problem.label} ${problem.title}：${error && error.message}`);
        }
        if (settings.requestInterval > 0 && index < selected.length - 1) {
          await api.sleep(settings.requestInterval);
        }
      }
    }
  );

  if (pulled) {
    // 索引从磁盘上的 .pta.json 生成，保证索引与本地实际文件一致
    const rebuilt = await library.rebuildIndex(root, problemSetId, name);
    if (rebuilt.indexPath) {
      log(`已更新题集索引：${rebuilt.indexPath}（共 ${rebuilt.count} 道）`);
    }
  }
  if (treeProvider) {
    treeProvider.refresh();
  }

  const parts = [`已拉取 ${pulled} 道（新建源码 ${created} 个，刷新 ${refreshed} 个）`];
  if (failures.length) {
    parts.push(`失败 ${failures.length} 道`);
  }
  const message = parts.join("，");
  log(message);
  const pick = await vscode.window.showInformationMessage(message, "打开索引", "打开文件夹");
  if (pick === "打开索引") {
    const indexPath = path.join(ws.buildProblemSetDirectory(root, problemSetId, name), ws.INDEX_FILE_NAME);
    if (await exists(indexPath)) {
      await vscode.window.showTextDocument(vscode.Uri.file(indexPath));
    }
  } else if (pick === "打开文件夹") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(root));
  }
}

/* ------------------------------------------------------------------ */
/* 定位当前题目                                                        */
/* ------------------------------------------------------------------ */

/**
 * 当前的题目：优先看编辑器里打开的文件，其次回退到预览面板里的题目。
 * @param {object} [options] { skipPanel: 不要回退到预览面板 }
 */
async function resolveCurrentProblem(options) {
  const opts = options || {};
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === "file") {
    const found = await ws.findMetadataUpward(editor.document.uri.fsPath);
    if (found) {
      return {
        problemDir: found.problemDir,
        metadata: found.metadata,
        metadataPath: found.metadataPath,
        document: editor.document
      };
    }
  }
  // 编辑器没打开题目文件（或焦点在预览面板上）时，回退到面板当前题目。
  //
  // skipPanel 是给 peekRoot 用的：面板里的题目要反查本地目录时又会调 peekRoot 拿根目录，
  // 「预览面板打开着」+「没设 pta.workspaceRoot」两者同时成立就会无限递归下去，
  // 最终抛 RangeError: Maximum call stack size exceeded（侧边栏刷新也会踩到，
  // 因为树里拿根目录走的也是 peekRoot）。到这里就直接认输，别绕回去。
  if (opts.skipPanel === true) {
    return null;
  }
  return resolveProblemFromPanel();
}

/** 以预览面板当前题目为上下文，找到本地目录与源码文档。 */
async function resolveProblemFromPanel() {
  const ref = panelProblemRef;
  if (!ref || !ref.problemSetId || !ref.problemId) {
    return null;
  }
  // 这里必须带 skipPanel：我们本身就是「面板里的题目」，
  // 再让 peekRoot 回去问面板就成了死循环（见 resolveCurrentProblem 的注释）。
  const root = (await peekRoot({ skipPanel: true })) || "";
  if (!root) {
    return null;
  }
  const local = await findLocalProblem(root, ref.problemSetId, ref.problemId);
  if (!local || !local.metadata) {
    return null;
  }
  const sourceName = local.metadata.sourceFile || templates.sourceFileName(local.metadata.language);
  const sourcePath = path.join(local.problemDir, sourceName);
  let document = null;
  if (await exists(sourcePath)) {
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
    } catch (_error) {
      document = null;
    }
  }
  return {
    problemDir: local.problemDir,
    metadata: local.metadata,
    metadataPath: path.join(local.problemDir, ws.METADATA_FILE_NAME),
    document
  };
}

async function requireCurrentProblem() {
  const current = await resolveCurrentProblem();
  if (!current) {
    const pick = await vscode.window.showWarningMessage(
      "没有找到当前题目：请打开题目目录里的文件，或从侧边栏点击题目打开预览。",
      "打开工作区"
    );
    if (pick === "打开工作区") {
      await commandOpenWorkspace();
    }
    return null;
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* 命令：登录 / 工作区                                                  */
/* ------------------------------------------------------------------ */

async function storeSession(cookie, user) {
  await extensionContext.secrets.store(SECRET_COOKIE, cookie);
  await extensionContext.globalState.update(STATE_USER, {
    id: user && user.id,
    user: (user && (user.nickname || user.email)) || (user && user.id) || "已登录"
  });
  await refreshStatusBar();
  if (treeProvider) {
    treeProvider.refresh();
  }
}

function describeUser(user) {
  if (!user) {
    return "成功";
  }
  return user.nickname || user.email || user.id || "成功";
}

/** 登录入口：选一种方式 */
async function commandLogin() {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(device-mobile) 微信扫码登录",
        detail: "推荐：二维码就在 VS Code 里，扫一下即完成登录，不用手动复制 Cookie",
        value: "wechat"
      },
      {
        label: "$(clippy) 粘贴 Cookie 登录",
        detail: "兜底方式：从浏览器复制 PTASession 值",
        value: "cookie"
      },
      {
        label: "$(key) 账号密码登录",
        detail: "PTA 现在要求先过图形验证码，在插件里走不通，会直接告诉你改用扫码",
        value: "password"
      }
    ],
    { placeHolder: "选择登录拼题A（PTA）的方式" }
  );
  if (!choice) {
    return;
  }
  if (choice.value === "wechat") {
    return commandLoginWechat();
  }
  if (choice.value === "cookie") {
    return commandLoginWithCookie();
  }
  return commandLoginWithPassword();
}

/** 微信扫码登录：自己生成二维码 → 轮询状态 → 换 Cookie */
async function commandLoginWechat() {
  if (activeLoginPanel && activeLoginPanel.isVisible()) {
    const pick = await vscode.window.showInformationMessage(
      "扫码登录窗口已经开着了。",
      "重新生成二维码"
    );
    if (pick !== "重新生成二维码") {
      return;
    }
  }

  const panel = new WechatLoginPanel();
  activeLoginPanel = panel;
  let refreshRequested = false;
  let closed = false;

  panel.show({
    status: "正在获取二维码…",
    onRefresh: () => {
      refreshRequested = true;
    },
    onDispose: () => {
      closed = true;
    }
  });

  try {
    while (!closed) {
      refreshRequested = false;

      let authInfo;
      try {
        authInfo = await auth.getWechatAuth();
      } catch (error) {
        panel.setStatus(error.message, "error");
        await handleError(error, "获取二维码失败");
        return;
      }
      log(`扫码登录：state=${authInfo.state}`);
      panel.setQr(authInfo.url);
      panel.setStatus("等待扫码…", "waiting");

      let result;
      try {
        result = await auth.waitForWechatScan(authInfo.state, {
          onStatus: (status) =>
            panel.setStatus(
              auth.describeStatus(status),
              status === auth.WECHAT_STATUS_SUCCESSFUL ? "done" : "waiting"
            ),
          isCancelled: () => closed || refreshRequested
        });
      } catch (error) {
        if (error && error.kind === "cancelled") {
          if (closed) {
            return;
          }
          log("扫码登录：用户刷新了二维码");
          continue;
        }
        panel.setStatus(error.message, "error");
        await handleError(error, "扫码登录失败");
        return;
      }

      let user;
      try {
        user = await api.getCurrentUser(result.cookie);
      } catch (_error) {
        user = null;
      }
      await storeSession(result.cookie, user || result.user);
      panel.setStatus("登录成功，窗口即将关闭。", "done");
      log(`扫码登录成功：${describeUser(user)}`);
      vscode.window.showInformationMessage(`已登录 PTA：${describeUser(user)}`);
      setTimeout(() => panel.dispose(), 900);
      return;
    }
  } finally {
    activeLoginPanel = undefined;
  }
}

/** 粘贴 Cookie 登录（永远可用的兜底） */
async function commandLoginWithCookie() {
  const input = await vscode.window.showInputBox({
    title: "登录拼题A（PTA）— 粘贴 Cookie",
    prompt: "粘贴浏览器里 pintia.cn 的 PTASession 值（F12 → Application → Cookies → PTASession）",
    placeHolder: "PTASession 的值，或整条 Cookie",
    ignoreFocusOut: true,
    validateInput: (value) => (value && value.trim() ? undefined : "不能为空")
  });
  if (!input) {
    return;
  }
  const cookie = api.parseCookieInput(input);
  try {
    const user = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在校验登录状态…" },
      async () => api.getCurrentUser(cookie)
    );
    if (!user) {
      vscode.window.showErrorMessage("PTA 没有返回用户信息，Cookie 可能无效。");
      return;
    }
    await storeSession(cookie, user);
    vscode.window.showInformationMessage(`已登录 PTA：${describeUser(user)}`);
  } catch (error) {
    await handleError(error, "登录失败");
  }
}

/** 账号密码登录：PTA 要图形验证码，这里只把原因说清楚 */
async function commandLoginWithPassword() {
  const email = await vscode.window.showInputBox({
    title: "账号密码登录（1/2）",
    prompt: "PTA 注册邮箱或手机号",
    ignoreFocusOut: true
  });
  if (!email) {
    return;
  }
  const password = await vscode.window.showInputBox({
    title: "账号密码登录（2/2）",
    prompt: "密码（仅用于本次登录请求，不会被保存）",
    password: true,
    ignoreFocusOut: true
  });
  if (!password) {
    return;
  }
  try {
    const cookie = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在登录…" },
      async () => auth.loginWithPassword({ email, password })
    );
    const user = await api.getCurrentUser(cookie);
    await storeSession(cookie, user);
    vscode.window.showInformationMessage(`已登录 PTA：${describeUser(user)}`);
  } catch (error) {
    if (error && error.kind === "captcha") {
      const pick = await vscode.window.showErrorMessage(error.message, "用微信扫码登录");
      if (pick === "用微信扫码登录") {
        await commandLoginWechat();
      }
      return;
    }
    await handleError(error, "登录失败");
  }
}

async function commandLogout() {
  const cookie = await extensionContext.secrets.get(SECRET_COOKIE);
  if (!cookie) {
    vscode.window.showInformationMessage("当前没有登录 PTA。");
    return;
  }
  try {
    await api.requestJson(`${api.ORIGIN}/api/u/info`, { method: "DELETE", cookie });
  } catch (_error) {
    /* 服务端登出失败不影响本地清理 */
  }
  await extensionContext.secrets.delete(SECRET_COOKIE);
  await extensionContext.globalState.update(STATE_USER, undefined);
  await refreshStatusBar();
  if (treeProvider) {
    treeProvider.refresh();
  }
  vscode.window.showInformationMessage("已退出 PTA 登录。");
}

async function commandChooseWorkspaceRoot() {
  const root = await getWorkspaceRoot({ forcePick: true });
  if (root) {
    vscode.window.showInformationMessage(`题解工作区已设为：${root}`);
  }
}

async function commandOpenWorkspace() {
  const root = await getWorkspaceRoot({});
  if (!root) {
    return;
  }
  if (!(await exists(root))) {
    vscode.window.showWarningMessage(`目录不存在：${root}`);
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), true);
}

/* ------------------------------------------------------------------ */
/* 命令：拉取                                                          */
/* ------------------------------------------------------------------ */

async function commandPullFromUrl() {
  let clipboard = "";
  try {
    clipboard = await vscode.env.clipboard.readText();
  } catch (_error) {
    clipboard = "";
  }
  const looksLikePta = /pintia\.cn\/problem-sets\/\d+/.test(clipboard);

  const input = await vscode.window.showInputBox({
    title: "从链接拉取",
    prompt: "粘贴题集或题目的完整链接（题目链接会只拉这一道）",
    value: looksLikePta ? clipboard.trim() : "",
    placeHolder: "https://pintia.cn/problem-sets/...",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || !value.trim()) {
        return "不能为空";
      }
      try {
        api.parsePtaUrl(value);
        return undefined;
      } catch (error) {
        return error.message;
      }
    }
  });
  if (!input) {
    return;
  }

  const parsed = api.parsePtaUrl(input);
  if (parsed.problemId) {
    const settings = getSettings();
    const root = await getWorkspaceRoot({});
    if (!root) {
      return;
    }
    const cookie = (await extensionContext.secrets.get(SECRET_COOKIE)) || "";
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "正在拉取题目…" },
        async () => buildOneProblem({ workspaceRoot: root, problemSetId: parsed.problemSetId, problemId: parsed.problemId, cookie, settings })
      );
      log(`已生成：${result.problemDir}`);
      const pick = await vscode.window.showInformationMessage(
        `已拉取「${result.metadata.label} ${result.metadata.title}」到 ${result.problemDirName}`,
        "打开题面",
        "打开源码"
      );
      if (pick === "打开题面") {
        await vscode.window.showTextDocument(vscode.Uri.file(result.statementPath));
      } else if (pick === "打开源码") {
        await vscode.window.showTextDocument(vscode.Uri.file(result.sourcePath));
      }
    } catch (error) {
      await handleError(error, "拉取题目失败");
    }
    return;
  }

  await pullProblemSet(parsed.problemSetId, "", {});
}

async function loadMyProblemSets(cookie) {
  const active = await api.getMyProblemSets(cookie, { onlyActive: true });
  const all = await api.getMyProblemSets(cookie, { onlyActive: false });
  const map = new Map();
  all.forEach((item) => map.set(item.id, item));
  active.forEach((item) => map.set(item.id, item));
  return Array.from(map.values());
}

/** 让用户从「我的题集」里挑一个，供多个命令复用 */
async function pickMyProblemSet(cookie, options) {
  const opts = options || {};
  let problemSets;
  try {
    problemSets = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在读取你的题集…" },
      async () => loadMyProblemSets(cookie)
    );
  } catch (error) {
    await handleError(error, "读取我的题集失败");
    return null;
  }
  if (!problemSets.length) {
    vscode.window.showWarningMessage("没有读到你的题集。");
    return null;
  }
  const picks = await vscode.window.showQuickPick(
    problemSets.map((item) => ({
      label: item.name || item.id,
      // 和侧边栏用同一套文案：已截止的题集只写「已截止」，
      // 不再把 PTA 的裸英文状态（PENDING 之类）漏到界面上。
      description: treeModel.problemSetDescription(item),
      detail: `题集 ID：${item.id}${item.organizationName ? ` · ${item.organizationName}` : ""}`,
      value: item
    })),
    { placeHolder: opts.placeHolder || "选择题集", matchOnDescription: true, matchOnDetail: true }
  );
  return picks ? picks.value : null;
}

async function commandPullMyProblemSet() {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }
  const picked = await pickMyProblemSet(cookie, { placeHolder: "选择要拉取的题集" });
  if (!picked) {
    return;
  }
  await pullProblemSet(picked.id, picked.name || "", { cookie });
}

async function commandPullPublicProblemSet() {
  let problemSets;
  try {
    problemSets = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在读取公开题集…" },
      async () => api.getAlwaysAvailableProblemSets()
    );
  } catch (error) {
    await handleError(error, "读取公开题集失败");
    return;
  }
  if (!problemSets.length) {
    vscode.window.showWarningMessage("没有读到公开题集。");
    return;
  }
  const picks = await vscode.window.showQuickPick(
    problemSets.map((item) => ({
      label: item.name || item.id,
      description: `${item.problemCount || ""}`,
      detail: `题集 ID：${item.id}${item.organizationName ? ` · ${item.organizationName}` : ""}`,
      value: item
    })),
    { placeHolder: "选择要拉取的公开题集", matchOnDescription: true, matchOnDetail: true }
  );
  if (!picks) {
    return;
  }
  const cookie = (await extensionContext.secrets.get(SECRET_COOKIE)) || "";
  await pullProblemSet(picks.value.id, picks.value.name || "", { cookie });
}

/** 从题目目录反推工作区根目录：…/problem-sets/{题集}/{题目} → 上三层 */
function deriveRootFromProblemDir(problemDir) {
  const setDir = path.dirname(problemDir);
  const setsRoot = path.dirname(setDir);
  if (path.basename(setsRoot) === ws.PROBLEM_SET_DIR_NAME) {
    return path.dirname(setsRoot);
  }
  return "";
}

/** 回 PTA 重新拉题面与样例，并重写本地文件。源码与笔记不会被覆盖。 */
async function refreshProblemWorkspace(root, problemDir, metadata) {
  const settings = getSettings();
  const cookie = (await extensionContext.secrets.get(SECRET_COOKIE)) || "";
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在刷新题面与样例…" },
    async () =>
      ws.ensureProblemWorkspace({
        workspaceRoot: root,
        problemDir,
        problemSetId: metadata.problemSetId,
        problemSetName: metadata.problemSetName,
        problem: await api.getProblemDetail(metadata.problemSetId, metadata.problemId, cookie),
        language: metadata.language,
        fileNameFormat: settings.fileNameFormat,
        templateDir: settings.templateDir,
        autoCreateSource: settings.autoCreateSource,
        createNotesFile: settings.createNotesFile,
        url: metadata.url,
        problemTypeName: metadata.problemTypeName
      })
  );
  log(`已刷新：${result.statementPath}`);
  return result;
}

async function commandRefreshCurrentProblem() {
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  const settings = getSettings();
  const root =
    settings.workspaceRoot ||
    deriveRootFromProblemDir(current.problemDir) ||
    (await getWorkspaceRoot({}));
  if (!root) {
    return;
  }
  try {
    await refreshProblemWorkspace(root, current.problemDir, current.metadata);
    vscode.window.showInformationMessage("题面与样例已刷新（源码与笔记未改动）。");
  } catch (error) {
    await handleError(error, "刷新失败");
  }
}

/**
 * 面板按钮「刷新题面」。
 *
 * 这里必须真的回 PTA 重新拉一次 —— 以前这个按钮只是把面板按本地的 problem.md
 * 重画一遍（`case "refresh": break;`），文件根本没被重写，于是看起来像「刷新了但没变」。
 * 按面板里的题目定位，不依赖当前编辑器，所以焦点在面板上时也能用。
 */
async function refreshProblemFromPanel(ref) {
  const root = (await peekRoot({ skipPanel: true })) || "";
  if (!root) {
    const pick = await vscode.window.showWarningMessage(
      "还没有选择题解目录，没法确定要刷新哪里。",
      "现在选择"
    );
    if (pick === "现在选择") {
      await commandChooseWorkspaceRoot();
    }
    return;
  }
  const local = await findLocalProblem(root, ref.problemSetId, ref.problemId);
  if (!local || !local.metadata) {
    vscode.window.showWarningMessage("这道题还没拉到本地，先点「创建代码」。");
    return;
  }
  try {
    await refreshProblemWorkspace(root, local.problemDir, local.metadata);
    vscode.window.showInformationMessage("题面与样例已刷新（源码与笔记未改动）。");
  } catch (error) {
    await handleError(error, "刷新题面失败");
  }
}

/* ------------------------------------------------------------------ */
/* 命令：本地跑样例 / 提交 / 测试                                       */
/* ------------------------------------------------------------------ */

function reportSampleResults(problemDir, outcome) {
  log(`本地跑样例：${problemDir}`);
  log(outcome.message);
  if (outcome.compileOutput) {
    log("编译输出：");
    log(outcome.compileOutput);
  }
  (outcome.results || []).forEach((item) => {
    log(
      `样例 ${item.index}：${item.passed ? "通过" : "未通过"}${
        item.timedOut ? "（超时）" : ""
      }${item.exitCode ? `（退出码 ${item.exitCode}）` : ""}`
    );
    if (!item.passed) {
      log(`  输入：${JSON.stringify(item.input)}`);
      log(`  期望输出：${JSON.stringify(item.expected)}`);
      log(`  实际输出：${JSON.stringify(item.actual)}`);
      if (item.stderr) {
        log(`  标准错误：${item.stderr.trim()}`);
      }
    }
  });
  log("");
}

async function commandRunSamples() {
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  const metadata = current.metadata;
  const settings = getSettings();
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在本地跑样例…" },
    async () =>
      runner.runSamples(current.problemDir, {
        language: metadata.language,
        sourceFileName: metadata.sourceFile,
        pythonPath: settings.pythonPath
      })
  );
  reportSampleResults(current.problemDir, outcome);

  if (!outcome.compiled) {
    const pick = await vscode.window.showErrorMessage(outcome.message, "查看输出");
    if (pick === "查看输出") {
      outputChannel.show();
    }
    return;
  }
  // 没全过就别用「信息」级别的提示框了，并且把第一个失败的原因直接写在消息里，
  // 免得还要点一次「查看详情」才知道差在哪。
  if (outcome.allPassed) {
    const pick = await vscode.window.showInformationMessage(outcome.message, "查看详情");
    if (pick === "查看详情") {
      outputChannel.show();
    }
    return;
  }
  const firstBad = (outcome.results || []).find((item) => !item.passed);
  const reason = firstBad
    ? `样例 ${firstBad.index} 未通过${
        firstBad.timedOut ? "（超时）" : firstBad.exitCode ? `（退出码 ${firstBad.exitCode}）` : "（输出不符）"
      }`
    : "";
  const pick = await vscode.window.showWarningMessage(
    reason ? `${outcome.message}：${reason}` : outcome.message,
    "查看详情"
  );
  if (pick === "查看详情") {
    outputChannel.show();
  }
}

function requireCompilerFor(metadata) {
  const compiler = api.compilerForLanguage(metadata.language);
  return compiler;
}

function submissionRunsOnServer(metadata) {
  // 判断这道题 PTA 是否真的支持这个语言（题目的 compiler 字段可能是 NO_COMPILER）
  const allowed = metadata.compiler;
  if (!allowed || allowed === "NO_COMPILER") {
    return true;
  }
  const expected = api.compilerForLanguage(metadata.language);
  return allowed.toUpperCase().includes(expected.toUpperCase());
}

async function commandSubmitCurrent() {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  const metadata = current.metadata;
  const code = notes.getCodeForSubmission(current.document.getText());
  if (!code.trim()) {
    vscode.window.showWarningMessage("源码是空的，没有可提交的内容。");
    return;
  }
  const compiler = requireCompilerFor(metadata);

  const confirm = await vscode.window.showWarningMessage(
    `用 ${metadata.language}（${compiler}）提交「${metadata.label || ""} ${metadata.title || ""}」？提交会计入 PTA 成绩。`,
    { modal: true },
    "提交"
  );
  if (confirm !== "提交") {
    return;
  }

  if (!submissionRunsOnServer(metadata)) {
    const go = await vscode.window.showWarningMessage(
      `这道题 PTA 侧的编译器是「${metadata.compiler}」，和你当前的 ${metadata.language} 不一致，可能提交失败。仍要提交吗？`,
      { modal: true },
      "继续提交"
    );
    if (go !== "继续提交") {
      return;
    }
  }

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在提交到 PTA…", cancellable: false },
      async (progress) =>
        submit.submitSolution({
          problemSetId: metadata.problemSetId,
          problemId: metadata.problemId,
          problemType: metadata.problemType,
          compiler,
          program: code,
          cookie,
          onProgress: (text) => progress.report({ message: `判题状态：${text}` })
        })
    );
    const report = submit.buildReport(result, {
      problemTitle: metadata.title,
      label: metadata.label,
      compiler,
      totalScore: metadata.score,
      timeLimit: metadata.timeLimit,
      memoryLimit: metadata.memoryLimit,
      isTest: false
    });
    log(report);
    const status = (result.data.submission || {}).status;
    if (api.isAccepted(status)) {
      const pick = await vscode.window.showInformationMessage(
        `答案正确（ACCEPTED）${metadata.label ? ` · ${metadata.label}` : ""}`,
        "查看详情"
      );
      if (pick === "查看详情") {
        outputChannel.show();
      }
    } else {
      const pick = await vscode.window.showWarningMessage(
        `提交结果：${api.submissionStatusText(status)}（${status}）`,
        "查看详情"
      );
      if (pick === "查看详情") {
        outputChannel.show();
      }
    }
  } catch (error) {
    await handleError(error, "提交失败");
  }
}

async function pickTestInput(current) {
  const items = [];
  const pairs = runner.findSamplePairs(path.join(current.problemDir, ws.SAMPLES_DIR_NAME));
  pairs.forEach((pair) => {
    const content = fs.readFileSync(pair.inputPath, "utf8");
    items.push({
      label: `$(three-bars) 本地样例 ${pair.index}`,
      detail: content.replace(/\s+$/, ""),
      value: content
    });
  });

  const blocks = notes.extractBlocks(current.document.getText());
  blocks.tests.forEach((test, index) => {
    items.push({
      label: `$(note) 源码里的 @pintia test 块 ${index + 1}`,
      detail: test,
      value: test
    });
  });

  items.push({ label: "$(pencil) 手动输入测试数据", value: ":input" });
  items.push({ label: "$(file-text) 从文件选择测试数据", value: ":file" });

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: "用哪组数据在 PTA 上测试？（不计入成绩）"
  });
  if (!choice) {
    return null;
  }
  if (choice.value === ":input") {
    const text = await vscode.window.showInputBox({
      prompt: "输入测试数据（用 \\n 表示换行）",
      placeHolder: "1 2\\n3 4",
      ignoreFocusOut: true
    });
    if (!text) {
      return null;
    }
    return text.replace(/\\n/g, "\n");
  }
  if (choice.value === ":file") {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "选择测试数据文件" });
    if (!picked || !picked.length) {
      return null;
    }
    return fs.readFileSync(picked[0].fsPath, "utf8");
  }
  return choice.value;
}

/** 查看最近一次提交：既能对当前打开的文件用，也能从侧边栏节点右键用 */
async function commandShowLastSubmission(argument) {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }

  let target;
  const ref = toProblemRef(argument);
  if (ref) {
    const root = await peekRoot();
    const local = root ? await findLocalProblem(root, ref.problemSetId, ref.problemId) : null;
    target = {
      problemSetId: ref.problemSetId,
      problemId: ref.problemId,
      label: ref.label || "",
      title: ref.title || "",
      score: ref.score,
      language: (local && local.metadata && local.metadata.language) || getSettings().language,
      timeLimit: local && local.metadata ? local.metadata.timeLimit : null,
      memoryLimit: local && local.metadata ? local.metadata.memoryLimit : null
    };
  } else {
    const current = await requireCurrentProblem();
    if (!current) {
      return;
    }
    const metadata = current.metadata;
    target = {
      problemSetId: metadata.problemSetId,
      problemId: metadata.problemId,
      label: metadata.label,
      title: metadata.title,
      score: metadata.score,
      language: metadata.language,
      timeLimit: metadata.timeLimit,
      memoryLimit: metadata.memoryLimit
    };
  }

  let submission;
  try {
    submission = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在读取最近一次提交…" },
      async () => api.getLastSubmission(target.problemSetId, target.problemId, cookie)
    );
  } catch (error) {
    await handleError(error, "读取提交记录失败");
    return;
  }
  if (!submission || !submission.id) {
    vscode.window.showInformationMessage(
      `「${target.label} ${target.title}」在 PTA 上还没有提交记录。`
    );
    return;
  }

  const compiler = submission.compiler || api.compilerForLanguage(target.language);
  const report = submit.buildReport(
    { data: { submission }, submissionId: submission.id },
    {
      problemTitle: target.title,
      label: target.label,
      compiler,
      totalScore: target.score,
      timeLimit: target.timeLimit,
      memoryLimit: target.memoryLimit,
      isTest: false
    }
  );
  log(`最近一次提交：\n${report}`);

  const status = submission.status || "";
  const score = submission.score === undefined || submission.score === null ? "" : `，得分 ${submission.score}`;
  const pick = await vscode.window.showInformationMessage(
    `最近一次提交：${api.submissionStatusText(status)}${score}`,
    "查看详情"
  );
  if (pick === "查看详情") {
    outputChannel.show();
  }
}

async function commandTestCurrent() {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  const metadata = current.metadata;
  const testInput = await pickTestInput(current);
  if (testInput === null || testInput === undefined) {
    return;
  }
  const code = notes.getCodeForSubmission(current.document.getText());
  const compiler = requireCompilerFor(metadata);

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在 PTA 上测试…", cancellable: false },
      async (progress) =>
        submit.testSolution({
          problemSetId: metadata.problemSetId,
          problemId: metadata.problemId,
          problemType: metadata.problemType,
          compiler,
          program: code,
          testInput,
          cookie,
          onProgress: (text) => progress.report({ message: `判题状态：${text}` })
        })
    );
    const report = submit.buildReport(result, {
      problemTitle: metadata.title,
      label: metadata.label,
      compiler,
      timeLimit: metadata.timeLimit,
      memoryLimit: metadata.memoryLimit,
      isTest: true
    });
    log(report);
    await vscode.window.showInformationMessage(
      `在线测试：${submit.shortStatusLine(result, { isTest: true })}`,
      "查看详情"
    );
  } catch (error) {
    await handleError(error, "在线测试失败");
  }
}

/* ------------------------------------------------------------------ */
/* 命令：笔记 / 语言 / 打开文件                                         */
/* ------------------------------------------------------------------ */

async function commandSyncNotes() {
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  try {
    const result = await notes.syncNotesFromCode(current.document.getText(), path.join(current.problemDir, ws.NOTES_FILE_NAME));
    log(`已同步代码里的笔记到 ${result.notesPath}`);
    const pick = await vscode.window.showInformationMessage("已把源码里的 @pintia note 同步进 notes.md", "打开 notes.md");
    if (pick === "打开 notes.md") {
      await vscode.window.showTextDocument(vscode.Uri.file(result.notesPath));
    }
  } catch (error) {
    await handleError(error, "同步笔记失败");
  }
}

async function commandSwitchLanguage() {
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  const settings = getSettings();
  const pick = await vscode.window.showQuickPick(
    templates.supportedLanguages().map((language) => ({
      label: language,
      description: templates.sourceFileName(language),
      detail: language === current.metadata.language ? "（当前使用）" : "",
      value: language
    })),
    { placeHolder: "切换到哪种语言？（已存在的文件不会被覆盖）" }
  );
  if (!pick) {
    return;
  }
  try {
    const result = await ws.applyLanguage(current.problemDir, current.metadata, pick.value, settings.templateDir);
    await updateSetting("defaultLanguage", pick.value);
    log(`已切换到 ${pick.value}：${result.sourcePath}`);
    await vscode.window.showTextDocument(vscode.Uri.file(result.sourcePath));
  } catch (error) {
    await handleError(error, "切换语言失败");
  }
}

async function commandOpenStatement() {
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  const statementPath = path.join(current.problemDir, ws.STATEMENT_FILE_NAME);
  if (!(await exists(statementPath))) {
    vscode.window.showWarningMessage("题目目录里没有 problem.md，可执行「PTA: 刷新当前题目的题面与样例」生成。");
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(statementPath));
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);
}

async function commandOpenProblemSetIndex() {
  const current = await resolveCurrentProblem();
  let startDir = current ? current.problemDir : "";
  if (!startDir) {
    const root = await getWorkspaceRoot({});
    if (!root) {
      return;
    }
    startDir = root;
  }
  let dir = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, ws.INDEX_FILE_NAME);
    if (await exists(candidate)) {
      await vscode.window.showTextDocument(vscode.Uri.file(candidate));
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  vscode.window.showWarningMessage("附近没有找到题集索引 index.md。");
}

/* ------------------------------------------------------------------ */
/* 命令：收藏 / 搜索 / 做题状态 / 签到                                  */
/* ------------------------------------------------------------------ */

/**
 * 只看已知信息推断工作区根目录，不弹框（侧边栏用）。
 * @param {object} [options] { skipPanel: 不要回头去问预览面板 }
 */
async function peekRoot(options) {
  const opts = options || {};
  const settings = getSettings();
  if (settings.workspaceRoot) {
    return settings.workspaceRoot;
  }
  const current = await resolveCurrentProblem({ skipPanel: opts.skipPanel === true });
  if (current) {
    const derived = deriveRootFromProblemDir(current.problemDir);
    if (derived) {
      return derived;
    }
  }
  return "";
}

/** 拿工作区根目录：设置里有就用，否则从当前题目反推，再不行才弹框 */
async function resolveRoot() {
  return (await peekRoot()) || (await getWorkspaceRoot({}));
}

/** 在本地找某道题（收藏夹 / 搜索结果的跳转用） */
async function findLocalProblem(root, problemSetId, problemId) {
  const setDir = await library.findLocalProblemSetDir(root, problemSetId);
  if (!setDir) {
    return null;
  }
  const entries = await ws.readProblemSetEntries(setDir);
  for (const entry of entries) {
    if (String(entry.metadata.problemId) === String(problemId)) {
      return entry;
    }
  }
  return null;
}

/** 打开一道题：本地有就打开题面，没有就问要不要现在拉取 */
async function openProblemRef(root, ref) {
  const local = await findLocalProblem(root, ref.problemSetId, ref.problemId);
  if (local) {
    const statementPath = path.join(local.problemDir, ws.STATEMENT_FILE_NAME);
    if (await exists(statementPath)) {
      await vscode.window.showTextDocument(vscode.Uri.file(statementPath));
      return;
    }
    const sourcePath = path.join(local.problemDir, local.metadata.sourceFile || templates.sourceFileName(local.metadata.language));
    if (await exists(sourcePath)) {
      await vscode.window.showTextDocument(vscode.Uri.file(sourcePath));
      return;
    }
  }

  const title = `${ref.label || ""} ${ref.title || ""}`.trim();
  const pick = await vscode.window.showInformationMessage(`「${title}」还没有拉到本地。`, "现在拉取", "在浏览器里打开");
  if (pick === "现在拉取") {
    const settings = getSettings();
    const cookie = (await extensionContext.secrets.get(SECRET_COOKIE)) || "";
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "正在拉取…" },
        async () =>
          buildOneProblem({
            workspaceRoot: root,
            problemSetId: ref.problemSetId,
            problemSetName: ref.problemSetName,
            problemId: ref.problemId,
            cookie,
            settings
          })
      );
      await vscode.window.showTextDocument(vscode.Uri.file(result.statementPath));
    } catch (error) {
      await handleError(error, "拉取失败");
    }
  } else if (pick === "在浏览器里打开") {
    await vscode.env.openExternal(
      vscode.Uri.parse(api.buildProblemUrl(ref.problemSetId, ref.problemId, ref.problemType))
    );
  }
}

/** 查提交记录：既能对当前打开的文件用，也能从侧边栏节点右键用 */
async function commandShowSubmissions(argument) {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }

  let target;
  const ref = toProblemRef(argument);
  if (ref) {
    target = { problemSetId: ref.problemSetId, problemId: ref.problemId, label: ref.label, title: ref.title };
  } else {
    const current = await requireCurrentProblem();
    if (!current) {
      return;
    }
    const metadata = current.metadata;
    target = {
      problemSetId: metadata.problemSetId,
      problemId: metadata.problemId,
      label: metadata.label,
      title: metadata.title
    };
  }

  const myUserId = (extensionContext.globalState.get(STATE_USER) || {}).id;
  const WANT = 30;
  const MAX_PAGES = 6;
  const collected = [];

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在读取提交记录…", cancellable: true },
      async (progress, token) => {
        let before = "";
        for (let page = 0; page < MAX_PAGES && !token.isCancellationRequested; page += 1) {
          const result = await api.getSubmissions(target.problemSetId, cookie, { limit: 100, before });
          const list = result.submissions || [];
          if (!list.length) {
            break;
          }
          // PTA 会忽略按题过滤的参数，只能取回来自己筛
          collected.push(
            ...submissions.filterSubmissions(list, { problemId: target.problemId, userId: myUserId })
          );
          progress.report({ message: `已找到 ${collected.length} 条（第 ${page + 1} 页）` });
          if (collected.length >= WANT || !result.hasBefore) {
            break;
          }
          before = list[list.length - 1].id;
          await api.sleep(getSettings().requestInterval);
        }
      }
    );
  } catch (error) {
    await handleError(error, "读取提交记录失败");
    return;
  }

  const mine = submissions.sortBySubmitAtDesc(submissions.dedupeById(collected));
  if (!mine.length) {
    vscode.window.showInformationMessage(
      `没有找到「${target.label || ""} ${target.title || ""}」的提交记录${
        myUserId ? "" : "（本地没有记录用户 ID，无法确认哪些是你自己的提交）"
      }。`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    mine.map((item) => Object.assign({ value: item }, submissions.describeSubmission(item))),
    {
      placeHolder: `「${target.label || ""} ${target.title || ""}」的提交记录（最近 ${mine.length} 条，时间倒序）`,
      matchOnDescription: true
    }
  );
  if (!picked) {
    return;
  }

  const submission = picked.value;
  const report = submit.buildReport(
    { data: { submission }, submissionId: submission.id },
    {
      problemTitle: target.title,
      label: target.label,
      compiler: submission.compiler,
      isTest: false
    }
  );
  log(`提交记录详情：\n${report}`);
  const action = await vscode.window.showInformationMessage(
    `提交于 ${submit.formatSubmitAt(submission.submitAt)}：${api.submissionStatusText(submission.status)}，` +
      `${submit.formatScore(submission.score)} 分`,
    "查看详情"
  );
  if (action === "查看详情") {
    outputChannel.show();
  }
}

/** 收藏 / 取消收藏（当前文件） */
async function commandToggleFavorite() {
  const current = await requireCurrentProblem();
  if (!current) {
    return;
  }
  const root = await resolveRoot();
  if (!root) {
    return;
  }
  const metadata = current.metadata;
  try {
    const result = await library.toggleFavorite(root, {
      problemSetId: metadata.problemSetId,
      problemSetName: metadata.problemSetName,
      problemId: metadata.problemId,
      label: metadata.label,
      title: metadata.title,
      problemType: metadata.problemType,
      problemTypeName: metadata.problemTypeName,
      score: metadata.score,
      url: metadata.url
    });
    const title = `${metadata.label || ""} ${metadata.title || ""}`.trim();
    if (treeProvider) {
      treeProvider.refresh();
    }
    vscode.window.showInformationMessage(
      result.favorited ? `已收藏「${title}」（共 ${result.total} 道）` : `已取消收藏「${title}」（剩余 ${result.total} 道）`
    );
  } catch (error) {
    await handleError(error, "收藏失败");
  }
}

async function commandOpenFavorites() {
  const root = await resolveRoot();
  if (!root) {
    return;
  }
  let items;
  try {
    items = await library.listFavorites(root);
  } catch (error) {
    await handleError(error, "读取收藏夹失败");
    return;
  }
  if (!items.length) {
    vscode.window.showInformationMessage(
      "收藏夹是空的。在题目里执行「PTA: 收藏 / 取消收藏当前题目」就会加进来。"
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    items.map((item) => ({
      label: `${item.label || ""} ${item.title || ""}`.trim(),
      description: [item.problemTypeName, item.score === null || item.score === undefined ? "" : `${item.score} 分`]
        .filter(Boolean)
        .join(" · "),
      detail: `来自：${item.problemSetName || item.problemSetId}`,
      value: item
    })),
    { placeHolder: `收藏夹（${items.length} 道）`, matchOnDescription: true, matchOnDetail: true }
  );
  if (!pick) {
    return;
  }
  await openProblemRef(root, pick.value);
}

/** 刷新当前题集的做题状态：一次请求拿到整个题集的状态 */
async function commandRefreshProblemStatus(argument) {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }
  const root = await resolveRoot();
  if (!root) {
    return;
  }

  const setRef = toSetRef(argument);
  let problemSetId = setRef ? setRef.problemSetId : "";
  let problemSetName = setRef ? setRef.problemSetName : "";

  if (!problemSetId) {
    const current = await resolveCurrentProblem();
    if (current && current.metadata) {
      problemSetId = current.metadata.problemSetId;
      problemSetName = current.metadata.problemSetName;
    }
  }
  if (!problemSetId) {
    const picked = await pickMyProblemSet(cookie, { placeHolder: "要刷新哪个题集的状态？" });
    if (!picked) {
      return;
    }
    problemSetId = String(picked.id);
    problemSetName = picked.name || "";
  }

  try {
    const statusList = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在读取做题状态…" },
      async () => api.getExamProblemStatus(problemSetId, cookie)
    );
    const result = await library.applyProblemStatus(root, problemSetId, problemSetName, statusList);
    if (!result.count) {
      vscode.window.showWarningMessage("这个题集在本地还没有题目，先拉取一次再刷新状态。");
      return;
    }
    log(`做题状态已更新：${result.updated} / ${result.count}，索引 ${result.indexPath}`);
    if (treeProvider) {
      treeProvider.refresh();
    }
    vscode.window.showInformationMessage(`已更新 ${result.updated} 道题的状态，索引已重建（共 ${result.count} 道）。`);
  } catch (error) {
    await handleError(error, "刷新做题状态失败");
  }
}

async function ensureSearchIndex(root, cookie, options) {
  const opts = options || {};
  if (!opts.force) {
    const cached = await library.loadSearchCache(root);
    if (cached) {
      return cached.problems;
    }
  }
  const problems = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在建立题目索引（首次会慢一些）…", cancellable: true },
    async (progress, token) =>
      library.buildSearchIndex({
        cookie,
        interval: getSettings().requestInterval,
        onProgress: (text) => progress.report({ message: text }),
        isCancelled: () => token.isCancellationRequested
      })
  );
  if (problems.length) {
    await library.saveSearchCache(root, problems);
  }
  return problems;
}

async function commandSearchProblem() {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }
  const root = await resolveRoot();
  if (!root) {
    return;
  }

  let problems;
  try {
    problems = await ensureSearchIndex(root, cookie, {});
  } catch (error) {
    await handleError(error, "建立题目索引失败");
    return;
  }
  if (!problems.length) {
    vscode.window.showWarningMessage("没有读到可搜索的题目（需要先登录，且「我的题集」里有题目）。");
    return;
  }

  const pick = await vscode.window.showQuickPick(
    problems.map((problem) => ({
      label: `${problem.label || ""} ${problem.title || ""}`.trim(),
      description: `${problem.problemSetName} · ${problem.problemTypeName}`,
      detail: `题集 ${problem.problemSetId} / 题目 ${problem.problemId}`,
      value: problem
    })),
    { placeHolder: `搜索题目（已索引 ${problems.length} 道，直接输入关键词过滤）`, matchOnDescription: true, matchOnDetail: true }
  );
  if (!pick) {
    return;
  }
  await openProblemRef(root, pick.value);
}

async function commandRefreshSearchIndex() {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }
  const root = await resolveRoot();
  if (!root) {
    return;
  }
  try {
    const problems = await ensureSearchIndex(root, cookie, { force: true });
    vscode.window.showInformationMessage(`题目索引已刷新：${problems.length} 道。`);
  } catch (error) {
    await handleError(error, "刷新题目索引失败");
  }
}

async function commandCheckIn() {
  const cookie = await getCookie({});
  if (!cookie) {
    return;
  }
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在签到…" },
      async () => {
        const status = await api.getCheckInStatus(cookie);
        if (status && status.exists) {
          return { already: true };
        }
        return { response: await api.checkIn(cookie) };
      }
    );
    if (result.already) {
      vscode.window.showInformationMessage("今天已经签到过了。");
      return;
    }
    const response = result.response || {};
    if (response.error && response.error.message) {
      vscode.window.showWarningMessage(`签到失败：${response.error.message}`);
      return;
    }
    const rewards =
      response.rewards && response.rewards.DAILY_CHECK_IN ? response.rewards.DAILY_CHECK_IN.rewards : null;
    const text = rewards && rewards.length
      ? rewards.map((item) => `${item.purchaseObjectType} ${item.amount}`).join("、")
      : "";
    log(`签到成功 ${text}`);
    vscode.window.showInformationMessage(`签到成功${text ? `：${text}` : ""}`);
  } catch (error) {
    await handleError(error, "签到失败");
  }
}

/* ------------------------------------------------------------------ */
/* 命令：侧边栏                                                        */
/* ------------------------------------------------------------------ */

/** 侧边栏的节点既能通过右键菜单（拿到 TreeItem）也能通过命令参数（拿到 ref）进来 */
function toProblemRef(argument) {
  if (!argument) {
    return null;
  }
  if (argument.ref) {
    return argument.ref;
  }
  if (argument.problemSetId && argument.problemId) {
    return argument;
  }
  return null;
}

function toSetRef(argument) {
  if (!argument) {
    return null;
  }
  if (argument.setRef) {
    return argument.setRef;
  }
  if (argument.problemSetId) {
    return { problemSetId: String(argument.problemSetId), problemSetName: argument.problemSetName || "" };
  }
  return null;
}

const TREE_HINT = "这个命令要从左侧 PTA 侧边栏的节点上使用。";

async function commandRefreshTree() {
  if (treeProvider) {
    treeProvider.refresh();
  }
}

/* ------------------------------------------------------------------ */
/* 题目预览面板                                                        */
/* ------------------------------------------------------------------ */

/** 从题目详情里取时限 / 内存（不同题型放在不同的配置键下）。 */
function detailLimits(detail) {
  const config = (detail && detail.problemConfig) || {};
  const inner =
    config.programmingProblemConfig ||
    config.codeCompletionProblemConfig ||
    config.multipleChoiceProblemConfig ||
    config.trueOrFalseProblemConfig ||
    {};
  return {
    timeLimit: inner.timeLimit || null,
    memoryLimit: inner.memoryLimit || null
  };
}

/**
 * 收集渲染预览面板所需的一切。
 * 本地已有 problem.md 就直接读文件（快，而且与磁盘内容一致）；否则请求 PTA。
 */
async function buildPreviewContext(ref, options) {
  const opts = options || {};
  const root = opts.root === undefined ? (await peekRoot()) || "" : opts.root;
  const cookie =
    opts.cookie === undefined ? (await extensionContext.secrets.get(SECRET_COOKIE)) || "" : opts.cookie;
  const settings = getSettings();

  let local = null;
  if (root) {
    try {
      local = await findLocalProblem(root, ref.problemSetId, ref.problemId);
    } catch (_error) {
      local = null;
    }
  }

  let statement = "";
  if (local) {
    const statementPath = path.join(local.problemDir, ws.STATEMENT_FILE_NAME);
    if (await exists(statementPath)) {
      // 本地 problem.md 里带着「给本地文件用的」包装：标题 + 元信息 + 末尾的「详细信息」。
      // 面板自己会用同一份文案渲染这两处，所以这里只取题面正文，免得同一批信息显示两遍。
      statement = ws.stripStatementWrapper(await fs.promises.readFile(statementPath, "utf8"));
    }
  }

  let detail = null;
  let fetchError = null;
  if (!statement) {
    try {
      detail = await api.getProblemDetail(ref.problemSetId, ref.problemId, cookie);
      statement = detail.description || detail.content || "";
    } catch (error) {
      fetchError = error;
    }
  }

  const metadata = (local && local.metadata) || {};
  const limits = detailLimits(detail);
  const problemType = detail ? detail.type : metadata.problemType;
  const language = metadata.language || settings.language;

  // 面板的「详细信息」要和 problem.md 里的对齐，所以这里得把同一批字段凑齐
  const fetchedAtDate = metadata.updatedAt ? new Date(metadata.updatedAt) : null;
  const meta = {
    problemTypeName: metadata.problemTypeName || api.problemTypeName(problemType),
    problemSetName: ref.problemSetName || metadata.problemSetName || "",
    problemSetId: String(ref.problemSetId),
    author: (detail && detail.author) || metadata.author || "",
    url: metadata.url || api.buildProblemUrl(ref.problemSetId, ref.problemId, problemType),
    // 「本地抓取」只有已经拉到本地才有得说；还没创建代码时这一条就不显示
    fetchedAt:
      fetchedAtDate && !Number.isNaN(fetchedAtDate.getTime()) ? ws.timestampForFile(fetchedAtDate) : "",
    score:
      metadata.score === undefined || metadata.score === null
        ? detail
          ? detail.score
          : ""
        : metadata.score,
    difficulty:
      metadata.difficulty === undefined || metadata.difficulty === null
        ? detail
          ? detail.difficulty
          : ""
        : metadata.difficulty,
    timeLimit: metadata.timeLimit || limits.timeLimit,
    memoryLimit: metadata.memoryLimit || limits.memoryLimit
  };

  const workspace = {
    hasWorkspace: Boolean(local),
    language,
    sourceFile: metadata.sourceFile || templates.sourceFileName(language),
    problemDir: local ? local.problemDir : "",
    hasNotes: local ? await exists(path.join(local.problemDir, ws.NOTES_FILE_NAME)) : false,
    answerStatus: metadata.statusShort && metadata.statusShort !== "-" ? metadata.statusShort : ""
  };

  const problem = {
    label: (detail && detail.label) || metadata.label || ref.label || "",
    title: (detail && detail.title) || metadata.title || ref.title || "",
    problemSetId: String(ref.problemSetId),
    problemId: String(ref.problemId)
  };

  return { root, problem, statement, meta, workspace, fetchError, loggedIn: Boolean(cookie) };
}

/** 把上下文渲染成面板标题与 HTML。 */
function renderPreview(context) {
  const ctx = context || {};
  const title = `${ctx.problem.label || ""} ${ctx.problem.title || ""}`.trim() || "题目";

  // 题面开头的 h1 由 problemPanel 剥掉（标题在面板顶部单独显示）
  let statement = ctx.statement || "";
  if (!statement) {
    const lines = [`> 暂时读不到题面：${ctx.fetchError ? ctx.fetchError.message : "内容为空"}`];
    lines.push("");
    lines.push(
      ctx.loggedIn
        ? "点「创建代码」时会重新拉取一次；如果还是失败，多半是这道题所在的题集需要权限。"
        : "看起来还没登录 —— 先执行「PTA: 登录（微信扫码）」，再回来刷新。"
    );
    statement = lines.join("\n");
  }

  return {
    title,
    html: buildPanelHtml({
      problem: ctx.problem,
      statement,
      meta: ctx.meta,
      workspace: ctx.workspace,
      root: ctx.root
    })
  };
}

/**
 * 打开（或复用）题目预览面板。
 * @param {object} ref     { problemSetId, problemId, label, title, problemSetName }
 * @param {object} [options] { silent: 不先显示骨架（刷新时用） }
 */
async function openProblemPanel(ref, options) {
  if (!problemPreview) {
    return null;
  }
  const opts = options || {};
  const key = `${ref.problemSetId}-${ref.problemId}`;
  panelProblemRef = {
    problemSetId: String(ref.problemSetId),
    problemId: String(ref.problemId),
    label: ref.label || "",
    title: ref.title || "",
    problemSetName: ref.problemSetName || ""
  };

  const initialTitle = `${ref.label || ""} ${ref.title || ""}`.trim() || "题目预览";
  if (!opts.silent) {
    problemPreview.show(key, initialTitle, renderPanelSkeleton(initialTitle));
  }

  let ctx;
  try {
    ctx = await buildPreviewContext(ref, opts);
  } catch (error) {
    await handleError(error, "打开题目预览失败");
    return null;
  }
  const rendered = renderPreview(ctx);
  problemPreview.update(key, rendered.title, rendered.html);
  if (ctx.fetchError) {
    log(`读取题面失败（${key}）：${ctx.fetchError.message}`);
  }
  return ctx;
}

/** 按当前题目重新渲染面板（不抢焦点）。 */
async function refreshProblemPanel() {
  if (!problemPreview || !panelProblemRef) {
    return;
  }
  await openProblemPanel(panelProblemRef, { silent: true });
}

/** 面板按钮：创建代码（首次会先让你选题解目录）。 */
async function createWorkFromPanel(ref) {
  const settings = getSettings();
  const cookie = (await extensionContext.secrets.get(SECRET_COOKIE)) || "";
  // 没设过题解目录时会先弹出目录选择框，并把这次选择记住，之后不再问
  const root = await getWorkspaceRoot({});
  if (!root) {
    return;
  }
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在生成「${ref.label || ""} ${ref.title || ""}」…`
      },
      async () =>
        buildOneProblem({
          workspaceRoot: root,
          problemSetId: ref.problemSetId,
          problemSetName: ref.problemSetName,
          problemId: ref.problemId,
          cookie,
          settings
        })
    );
    if (treeProvider) {
      treeProvider.refresh();
    }
    log(`已创建题目工作区：${result.problemDir}`);
    if (result.sourcePath && (await exists(result.sourcePath))) {
      await vscode.window.showTextDocument(vscode.Uri.file(result.sourcePath));
    }
  } catch (error) {
    await handleError(error, "创建代码失败");
  }
}

/** 面板按钮：打开代码（本地没有就先创建）。 */
async function openCodeFromPanel(ref) {
  const root = (await peekRoot()) || "";
  const local = root ? await findLocalProblem(root, ref.problemSetId, ref.problemId) : null;
  const sourcePath =
    local && local.problemDir
      ? path.join(
          local.problemDir,
          (local.metadata && local.metadata.sourceFile) || templates.sourceFileName(local.metadata.language)
        )
      : "";
  if (sourcePath && (await exists(sourcePath))) {
    await vscode.window.showTextDocument(vscode.Uri.file(sourcePath));
    return;
  }
  await createWorkFromPanel(ref);
}

/** 面板上所有按钮的落点。 */
async function handlePanelCommand(command) {
  const ref = panelProblemRef ? Object.assign({}, panelProblemRef) : null;
  switch (command) {
    case "createWork":
      if (ref) {
        await createWorkFromPanel(ref);
      }
      break;
    case "openCode":
      if (ref) {
        await openCodeFromPanel(ref);
      }
      break;
    case "openStatement":
      await commandOpenStatement();
      break;
    case "runSamples":
      await commandRunSamples();
      break;
    case "submit":
      await commandSubmitCurrent();
      break;
    case "test":
      await commandTestCurrent();
      break;
    case "switchLanguage":
      await commandSwitchLanguage();
      break;
    case "syncNotes":
      await commandSyncNotes();
      break;
    case "openInBrowser":
      if (ref) {
        await commandOpenItemInBrowser(ref);
      }
      break;
    case "chooseRoot":
      await commandChooseWorkspaceRoot();
      break;
    case "refresh":
      // 真的回 PTA 重新拉一次并重写 problem.md（下面统一重渲染面板）
      if (ref) {
        await refreshProblemFromPanel(ref);
      }
      break;
    default:
      return;
  }
  // 动作完成后重渲染：例如创建成功后，主按钮要从「创建代码」变成「打开代码」
  await refreshProblemPanel();
}

/** 命令：预览题目（侧边栏点击题目走这里）。 */
async function commandPreviewProblem(argument) {
  let ref = toProblemRef(argument);
  if (!ref) {
    const current = await resolveCurrentProblem();
    if (current && current.metadata) {
      ref = {
        problemSetId: current.metadata.problemSetId,
        problemId: current.metadata.problemId,
        label: current.metadata.label,
        title: current.metadata.title,
        problemSetName: current.metadata.problemSetName
      };
    }
  }
  if (!ref) {
    vscode.window.showInformationMessage("从左侧「PTA」侧边栏点击题目即可打开预览。");
    return;
  }
  await openProblemPanel(ref);
}

/** 命令：打开本地文件（右键菜单用；侧边栏点击走的是预览面板）。 */
async function commandOpenItem(argument) {
  const ref = toProblemRef(argument);
  if (!ref) {
    vscode.window.showInformationMessage(TREE_HINT);
    return;
  }
  const root = await resolveRoot();
  if (!root) {
    return;
  }
  await openProblemRef(root, ref);
}

async function commandPullItem(argument) {
  const ref = toProblemRef(argument);
  if (!ref) {
    vscode.window.showInformationMessage(TREE_HINT);
    return;
  }
  const root = await resolveRoot();
  if (!root) {
    return;
  }
  const settings = getSettings();
  const cookie = (await extensionContext.secrets.get(SECRET_COOKIE)) || "";
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在拉取「${ref.label || ""} ${ref.title || ""}」…` },
      async () =>
        buildOneProblem({
          workspaceRoot: root,
          problemSetId: ref.problemSetId,
          problemSetName: ref.problemSetName,
          problemId: ref.problemId,
          cookie,
          settings
        })
    );
    if (treeProvider) {
      treeProvider.refresh();
    }
    const pick = await vscode.window.showInformationMessage(
      `已拉取到 ${result.problemDirName}`,
      "打开题面",
      "打开源码"
    );
    if (pick === "打开题面") {
      await vscode.window.showTextDocument(vscode.Uri.file(result.statementPath));
    } else if (pick === "打开源码") {
      await vscode.window.showTextDocument(vscode.Uri.file(result.sourcePath));
    }
  } catch (error) {
    await handleError(error, "拉取失败");
  }
}

async function commandPullSet(argument) {
  const setRef = toSetRef(argument);
  if (!setRef) {
    vscode.window.showInformationMessage(TREE_HINT);
    return;
  }
  await pullProblemSet(setRef.problemSetId, setRef.problemSetName, {});
}

async function commandFavoriteItem(argument) {
  const ref = toProblemRef(argument);
  if (!ref) {
    vscode.window.showInformationMessage(TREE_HINT);
    return;
  }
  const root = await resolveRoot();
  if (!root) {
    return;
  }
  try {
    const result = await library.toggleFavorite(root, ref);
    if (treeProvider) {
      treeProvider.refresh();
    }
    const title = `${ref.label || ""} ${ref.title || ""}`.trim();
    vscode.window.showInformationMessage(
      result.favorited ? `已收藏「${title}」（共 ${result.total} 道）` : `已取消收藏「${title}」`
    );
  } catch (error) {
    await handleError(error, "收藏失败");
  }
}

async function commandOpenItemInBrowser(argument) {
  const ref = toProblemRef(argument);
  if (!ref) {
    vscode.window.showInformationMessage(TREE_HINT);
    return;
  }
  await vscode.env.openExternal(
    vscode.Uri.parse(api.buildProblemUrl(ref.problemSetId, ref.problemId, ref.problemType))
  );
}

/* ------------------------------------------------------------------ */
/* 命令：诊断                                                          */
/* ------------------------------------------------------------------ */

async function commandDiagnose() {
  const root = await getWorkspaceRoot({});
  if (!root) {
    return;
  }
  const current = await resolveCurrentProblem();
  let problemSetId = current && current.metadata ? current.metadata.problemSetId : "";
  let problemId = current && current.metadata ? current.metadata.problemId : "";

  if (!problemSetId) {
    const input = await vscode.window.showInputBox({
      title: "PTA 诊断",
      prompt: "输入题集或题目的链接",
      placeHolder: "https://pintia.cn/problem-sets/...",
      ignoreFocusOut: true
    });
    if (!input) {
      return;
    }
    const parsed = api.parsePtaUrl(input);
    problemSetId = parsed.problemSetId;
    problemId = parsed.problemId || "";
  }

  const cookie = (await extensionContext.secrets.get(SECRET_COOKIE)) || "";
  const targetDir = path.join(root, DIAGNOSE_DIR);
  await fs.promises.mkdir(targetDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  const jobs = [
    { name: "problem-summaries", url: `${api.ORIGIN}/api/problem-sets/${problemSetId}/problem-summaries` },
    {
      name: "exam-problem-list",
      url: `${api.ORIGIN}/api/problem-sets/${problemSetId}/exam-problem-list?problem_type=PROGRAMMING&page=0&limit=20`
    },
    { name: "exams", url: `${api.ORIGIN}/api/problem-sets/${problemSetId}/exams` }
  ];
  if (problemId) {
    jobs.push({
      name: "exam-problems-detail",
      url: `${api.ORIGIN}/api/problem-sets/${problemSetId}/exam-problems/${problemId}`
    });
  }

  for (const job of jobs) {
    try {
      const response = await api.rawRequest(job.url, { cookie });
      const file = path.join(targetDir, `${stamp}-${job.name}.json`);
      await fs.promises.writeFile(file, response.text, "utf8");
      results.push(`${job.name}: HTTP ${response.status}`);
      log(`诊断 ${job.name} -> ${file}`);
    } catch (error) {
      results.push(`${job.name}: ${error.message}`);
      log(`诊断 ${job.name} 失败：${error.message}`);
    }
  }

  const summaryPath = path.join(targetDir, `${stamp}-summary.txt`);
  await fs.promises.writeFile(
    summaryPath,
    [
      `题集 ID：${problemSetId}`,
      problemId ? `题目 ID：${problemId}` : "",
      `是否带登录态：${cookie ? "是" : "否"}`,
      "",
      ...results,
      "",
      "把这个目录一起发出来，接口一变就能定位问题。"
    ]
      .filter(Boolean)
      .join("\n"),
    "utf8"
  );

  const pick = await vscode.window.showInformationMessage(
    `诊断完成，已写入 ${DIAGNOSE_DIR}/`,
    "打开诊断目录",
    "查看输出"
  );
  if (pick === "打开诊断目录") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(targetDir));
  } else if (pick === "查看输出") {
    outputChannel.show();
  }
}

/* ------------------------------------------------------------------ */
/* 激活                                                                */
/* ------------------------------------------------------------------ */

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel(OUTPUT_NAME);
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  const register = (command, handler) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, (...args) => {
        Promise.resolve()
          .then(() => handler(...args))
          .catch((error) => handleError(error));
      })
    );

  register("pta.login", commandLogin);
  register("pta.loginWechat", commandLoginWechat);
  register("pta.loginWithCookie", commandLoginWithCookie);
  register("pta.logout", commandLogout);
  register("pta.chooseWorkspaceRoot", commandChooseWorkspaceRoot);
  register("pta.openWorkspace", commandOpenWorkspace);
  register("pta.pullFromUrl", commandPullFromUrl);
  register("pta.pullMyProblemSet", commandPullMyProblemSet);
  register("pta.pullPublicProblemSet", commandPullPublicProblemSet);
  register("pta.refreshCurrentProblem", commandRefreshCurrentProblem);
  register("pta.runSamples", commandRunSamples);
  register("pta.submitCurrent", commandSubmitCurrent);
  register("pta.testCurrent", commandTestCurrent);
  register("pta.showLastSubmission", commandShowLastSubmission);
  register("pta.showSubmissions", commandShowSubmissions);
  register("pta.syncNotes", commandSyncNotes);
  register("pta.switchLanguage", commandSwitchLanguage);
  register("pta.openStatement", commandOpenStatement);
  register("pta.openProblemSetIndex", commandOpenProblemSetIndex);
  register("pta.toggleFavorite", commandToggleFavorite);
  register("pta.openFavorites", commandOpenFavorites);
  register("pta.refreshProblemStatus", commandRefreshProblemStatus);
  register("pta.searchProblem", commandSearchProblem);
  register("pta.refreshSearchIndex", commandRefreshSearchIndex);
  register("pta.checkin", commandCheckIn);
  register("pta.refreshTree", commandRefreshTree);
  register("pta.previewProblem", commandPreviewProblem);
  register("pta.openItem", commandOpenItem);
  register("pta.pullItem", commandPullItem);
  register("pta.pullSet", commandPullSet);
  register("pta.favoriteItem", commandFavoriteItem);
  register("pta.openItemInBrowser", commandOpenItemInBrowser);
  register("pta.diagnose", commandDiagnose);

  problemPreview = new ProblemPanel(handlePanelCommand, () => {
    panelProblemRef = null;
  });

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "c" },
        { language: "cpp" },
        { language: "python" },
        { language: "java" }
      ],
      new PtaCodeLensProvider()
    )
  );

  treeProvider = new PtaTreeDataProvider({
    getCookie: async () => (await extensionContext.secrets.get(SECRET_COOKIE)) || "",
    getWorkspaceRoot: peekRoot,
    log
  });
  context.subscriptions.push(vscode.window.registerTreeDataProvider(TREE_VIEW_ID, treeProvider));

  context.subscriptions.push(outputChannel, statusBarItem);
  refreshStatusBar();
  log("PTA Toolkit 已激活。");
}

function deactivate() {
  /* 无需清理 */
}

module.exports = { activate, deactivate };
