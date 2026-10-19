"use strict";

/**
 * 题目预览面板（Webview）。
 *
 * 交互照 xmuoj 插件的做法：面板里渲染题面与样例，主按钮随「本地是否已有工作区」
 * 在「创建代码」与「打开代码」之间切换，按钮点击通过 postMessage 回传命令。
 *
 * 本文件只负责「把上下文渲染成 HTML」和「管理面板实例」，
 * 具体动作由 extension.js 处理，便于对 HTML 做单测。
 */

const path = require("path");
const fs = require("fs");
const markdown = require("./markdown");
const problemInfo = require("./problemInfo");

/**
 * MathJax 走本地文件，不走 CDN。
 *
 * 以前是从 jsdelivr 加载，但他机器上有加速器/代理，webview 里拉不下来 ——
 * 结果公式全变成原样的 \(A\)。现在把 tex-svg.js（SVG 输出，自包含、不需要额外字体）
 * 打进 vendor/ 里，断网也能渲染；万一包里没有这个文件，再退回 CDN。
 */
const MATHJAX_CDN = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
const MATHJAX_LOCAL = path.join(__dirname, "..", "vendor", "mathjax", "tex-svg.js");

/** 本地资源来源（webview.cspSource）只有面板实例才知道，先占位。 */
const CSP_PLACEHOLDER = "__PTA_CSP_SOURCE__";

const { escapeHtml, renderMarkdown } = markdown;

const ICONS = {
  create:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h6l2 2h8v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" fill="currentColor"/></svg>',
  submit:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  test: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v4l4 11a2 2 0 0 1-1.9 2.6H6.9A2 2 0 0 1 5 18L9 7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  language:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M15 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12h6M9 16h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  browser:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
};

const PANEL_COMMANDS = [
  "createWork",
  "openCode",
  "openStatement",
  "runSamples",
  "submit",
  "test",
  "switchLanguage",
  "syncNotes",
  "openInBrowser",
  "chooseRoot",
  "refresh"
];

function actionButton(command, iconKey, label, variant) {
  return (
    `<button class="action ${variant || ""}" data-command="${command}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">` +
    `<span class="ico">${ICONS[iconKey] || ICONS.run}</span><span class="lbl">${escapeHtml(label)}</span></button>`
  );
}

function badge(label, value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return `<span class="badge"><span class="badge-key">${escapeHtml(label)}</span>${escapeHtml(String(value))}</span>`;
}

/**
 * 去掉题面开头的 h1 —— 标题已经由面板自己显示，留着会重复。
 * 只剥最开头的那一个一级标题，正文里的标题不动。
 */
function stripLeadingHeading(markdown) {
  return String(markdown || "")
    .replace(/^[ \t]*#[ \t]+[^\n]*(?:\n|$)/, "")
    .replace(/^\s*\n/, "");
}

/** 面板首次打开时的骨架（还没拿到题面）。 */
function renderPanelSkeleton(title) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escapeHtml(title || "题目预览")}</title>
<style>${BASE_STYLE}</style></head>
<body><div class="wrap"><p class="hint">正在载入题目…</p></div></body></html>`;
}

const BASE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    /* 这是「读题」面板，不是编辑器。完全跟着编辑器的字号（默认才 13px）读起来偏小，
       所以用 max() 兜底：至少 15px；用户把编辑器字号调大时也跟着一起变大。 */
    font-size: max(15px, var(--vscode-font-size, 13px));
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }
  .wrap { max-width: 900px; margin: 0 auto; padding: 26px 30px 64px; }
  h1 { font-size: 1.5em; font-weight: 500; margin: 0 0 14px; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 999px; padding: 4px 11px; font-size: .8em;
  }
  .badge-key { opacity: .7; }
  /* 前面那行「时间限制 400 ms · 内存限制 65536 KB（64.0 MB）」——
     和 problem.md 顶部那行同一份文案（problemInfo.limitsText）。 */
  .limits { margin: -2px 0 14px; }
  .limits .limit { white-space: nowrap; }
  .limits .limit-key { color: var(--vscode-descriptionForeground); margin-right: 6px; }
  .limits .limit-sep { color: var(--vscode-descriptionForeground); margin: 0 10px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .action {
    display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
    min-width: 86px; min-height: 62px; padding: 9px 11px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 8px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    font-family: inherit; font-size: .88em;
  }
  .action:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .action.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .action.primary:hover { background: var(--vscode-button-hoverBackground); }
  .action .ico { display: inline-flex; width: 18px; height: 18px; }
  .action .ico svg { width: 18px; height: 18px; display: block; }
  .action .lbl { line-height: 1.2; text-align: center; white-space: nowrap; }
  .rootline {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 10px 12px; margin-bottom: 18px; font-size: .88em;
    background: var(--vscode-editorWidget-background);
  }
  .rootline.warn { border-color: var(--vscode-editorWarning-foreground); }
  .rootline code { font-family: var(--vscode-editor-font-family); }
  .rootline .grow { flex: 1 1 auto; min-width: 0; word-break: break-all; }
  .rootline button {
    cursor: pointer; padding: 5px 11px; border-radius: 6px; font-size: .88em;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  .statement {
    border: 1px solid var(--vscode-panel-border); border-radius: 10px;
    padding: 6px 22px 18px; background: var(--vscode-editorWidget-background);
  }
  /* 标题用 em，跟着上面的基准字号一起放大，别写死 px */
  .statement h1, .statement h2, .statement h3, .statement h4 { font-weight: 500; line-height: 1.4; }
  .statement h1 { font-size: 1.4em; }
  .statement h2 { font-size: 1.2em; margin-top: 24px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  .statement h3 { font-size: 1.05em; margin-top: 20px; }
  .statement p, .statement li { line-height: 1.8; }
  .statement code {
    font-family: var(--vscode-editor-font-family); font-size: .92em;
    background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px;
    /* PTA 网页上的行内代码是红的（Bootstrap 那套配色），
       「Error: Ca != Rb」这种关键输出不标红的话，在面板里就跟普通文字没区别。 */
    color: var(--vscode-errorForeground);
  }
  .statement pre.code {
    background: var(--vscode-textCodeBlock-background); padding: 13px 15px;
    border-radius: 8px; overflow: auto;
  }
  /* 代码块不跟着标红 —— 网页上红的只有行内代码 */
  .statement pre.code code { background: none; padding: 0; color: inherit; }
  .statement table { border-collapse: collapse; margin: 12px 0; width: 100%; }
  .statement th, .statement td { border: 1px solid var(--vscode-panel-border); padding: 7px 11px; text-align: left; }
  .statement th { background: var(--vscode-textCodeBlock-background); font-weight: 500; }
  .statement a { color: var(--vscode-textLink-foreground); }
  .statement img { max-width: 100%; height: auto; }
  .statement blockquote {
    margin: 12px 0; padding: 2px 14px; border-left: 3px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .math-inline, .math-block {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 0 4px;
  }
  .math-block { display: block; padding: 10px; margin: 10px 0; overflow-x: auto; }
  /* 末尾的「详细信息」—— 和 problem.md 里那个小节同一批字段、同一个顺序 */
  .details {
    margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border);
    font-size: .88em; color: var(--vscode-descriptionForeground);
  }
  .details-title { font-weight: 500; color: var(--vscode-foreground); margin-bottom: 8px; }
  .detail-row { display: flex; gap: 10px; padding: 2px 0; }
  .detail-key { flex: 0 0 auto; min-width: 5.5em; opacity: .85; }
  .detail-value { flex: 1 1 auto; min-width: 0; word-break: break-all; }
  .hint { color: var(--vscode-descriptionForeground); }
  .footer { margin-top: 14px; font-size: .85em; color: var(--vscode-descriptionForeground); }
`;

/**
 * 渲染题目预览面板。
 * @param {object} context
 * @param {object} context.problem    { label, title, problemSetId, problemId }
 * @param {string} context.statement  Markdown 题面
 * @param {object} [context.meta]     徽章信息（分值 / 时限 / 内存 / 类型 / 状态）
 * @param {object} [context.workspace] { hasWorkspace, language, sourceFile, problemDir, hasNotes, answerStatus }
 * @param {string} [context.root]     题解工作区根目录
 * @param {boolean} [context.canSubmit]
 */
function buildPanelHtml(context) {
  const ctx = context || {};
  const problem = ctx.problem || {};
  const meta = ctx.meta || {};
  const workspace = ctx.workspace || {};
  const title = `${problem.label || ""} ${problem.title || ""}`.trim() || "题目";
  const hasWorkspace = Boolean(workspace.hasWorkspace);

  // 题目本身的信息（时限 / 内存 / 详细信息）统一由 problemInfo 出文案，
  // 和生成到本地的 problem.md 完全一致 —— 创建代码之前和之后看到的是同一套。
  const limitItems = problemInfo.limitItems(meta);
  const limitsLine = limitItems.length
    ? `<div class="limits">${limitItems
        .map(
          (item) =>
            `<span class="limit"><span class="limit-key">${escapeHtml(item.label)}</span>${escapeHtml(item.value)}</span>`
        )
        .join('<span class="limit-sep">·</span>')}</div>`
    : "";

  // 余下的徽章只表示「本地状态」；题目自身的元信息已经进了上面那行和下面的详细信息
  const badges = [
    badge("状态", workspace.answerStatus),
    badge("语言", hasWorkspace ? workspace.language : ""),
    badge("本地", hasWorkspace ? workspace.sourceFile : "")
  ]
    .filter(Boolean)
    .join("");

  const details = problemInfo.detailItems(meta);
  const detailsBlock = details.length
    ? `<div class="details"><div class="details-title">详细信息</div>${details
        .map(
          (item) =>
            `<div class="detail-row"><span class="detail-key">${escapeHtml(item.label)}</span>` +
            `<span class="detail-value">${escapeHtml(item.value)}</span></div>`
        )
        .join("")}</div>`
    : "";

  const actions = [];
  actions.push(
    hasWorkspace
      ? actionButton("openCode", "open", "打开代码", "primary")
      : actionButton("createWork", "create", "创建代码", "primary")
  );
  if (hasWorkspace) {
    actions.push(actionButton("openStatement", "edit", "打开题面"));
    actions.push(actionButton("runSamples", "run", "运行样例"));
    actions.push(actionButton("switchLanguage", "language", "切换语言"));
    if (workspace.hasNotes) {
      actions.push(actionButton("syncNotes", "note", "同步笔记"));
    }
  }
  if (ctx.canSubmit !== false) {
    actions.push(actionButton("submit", "submit", "提交到 PTA"));
    actions.push(actionButton("test", "test", "在线测试"));
  }
  actions.push(actionButton("openInBrowser", "browser", "浏览器打开"));
  actions.push(actionButton("refresh", "refresh", "刷新题面"));

  const rootLine = ctx.root
    ? `<div class="rootline"><span>题解目录</span><code class="grow">${escapeHtml(ctx.root)}</code><button data-command="chooseRoot">更改</button></div>`
    : `<div class="rootline warn"><span class="grow">还没有选择题解目录。点「创建代码」时会先让你选一个目录，它记住这个选择，以后不再问。</span><button data-command="chooseRoot">现在选择</button></div>`;

  const statement = ctx.statement
    ? renderMarkdown(stripLeadingHeading(ctx.statement))
    : '<p class="hint">正在载入题面…</p>';

  const localLine = hasWorkspace
    ? `<div class="footer">本地目录：${escapeHtml(path.basename(workspace.problemDir || ""))}${
        workspace.sourceFile ? ` · 源码：${escapeHtml(workspace.sourceFile)}` : ""
      }</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; media-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net ${CSP_PLACEHOLDER}; font-src https: data:; connect-src https:;">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}</style>
<script>
  window.MathJax = {
    tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']], processEscapes: true },
    options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] },
    svg: { fontCache: 'global' }
  };
</script>
<script id="MathJax-script" async src="${MATHJAX_CDN}"></script>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(title)}</h1>
    ${limitsLine}
    ${badges ? `<div class="badges">${badges}</div>` : ""}
    <div class="actions">${actions.join("")}</div>
    ${rootLine}
    <div class="statement">${statement}</div>
    ${detailsBlock}
    ${localLine}
  </div>
  <script>
    (function () {
      const api = acquireVsCodeApi();
      document.querySelectorAll('[data-command]').forEach(function (button) {
        button.addEventListener('click', function () {
          api.postMessage({ command: button.getAttribute('data-command') });
        });
      });
    })();
  </script>
</body>
</html>`;
}

/** 面板管理器：同屏只保留一个题目面板，切换题目时复用。 */
class ProblemPanel {
  constructor(onMessage, onDispose) {
    this.onMessage = onMessage;
    this.onDispose = onDispose;
    this.panel = null;
    this.currentKey = "";
  }

  static viewColumn() {
    const vscode = require("vscode");
    return vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  }

  create(title) {
    const vscode = require("vscode");
    const panel = vscode.window.createWebviewPanel("ptaProblemPreview", title, ProblemPanel.viewColumn(), {
      enableScripts: true,
      retainContextWhenHidden: true,
      // 允许加载 vendor/mathjax 里的本地 MathJax
      localResourceRoots: [vscode.Uri.file(path.join(__dirname, "..", "vendor"))]
    });
    panel.iconPath = undefined;
    panel.webview.onDidReceiveMessage(async (message) => {
      const command = message && message.command;
      if (!command) {
        return;
      }
      try {
        await this.onMessage(command);
      } catch (_error) {
        /* 由 onMessage 内部处理错误提示 */
      }
    });
    panel.onDidDispose(() => {
      this.panel = null;
      this.currentKey = "";
      if (typeof this.onDispose === "function") {
        this.onDispose();
      }
    });
    this.panel = panel;
    return panel;
  }

  /** 打开或复用一个面板并渲染内容。key 变化表示换了题目。 */
  /**
   * 把 buildPanelHtml 产出的 HTML 补上面板实例才知道的东西：
   *   · CSP 里的本地资源来源（webview.cspSource）
   *   · MathJax 地址 —— 优先用 vendor/mathjax 里的本地文件
   *     （走 CDN 时，网络里一旦有代理/加速器拦掉 jsdelivr，公式就只剩原始 LaTeX）
   */
  patchHtml(html) {
    const vscode = require("vscode");
    let out = String(html || "").split(CSP_PLACEHOLDER).join(this.panel.webview.cspSource);
    try {
      if (fs.existsSync(MATHJAX_LOCAL)) {
        const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(MATHJAX_LOCAL)).toString();
        out = out.split(MATHJAX_CDN).join(uri);
      }
    } catch (_error) {
      /* 换不到本地 URI 就用 CDN，别把面板搞崩 */
    }
    return out;
  }

  show(key, title, html) {
    const vscode = require("vscode");
    if (!this.panel) {
      this.create(title);
    } else {
      this.panel.title = title;
      this.panel.reveal(ProblemPanel.viewColumn(), false);
    }
    this.currentKey = key;
    this.panel.webview.html = this.patchHtml(html);
    return this.panel;
  }

  /** 只更新内容，不抢焦点（用于状态刷新）。 */
  update(key, title, html) {
    if (!this.panel || this.currentKey !== key) {
      return this.show(key, title, html);
    }
    this.panel.title = title;
    this.panel.webview.html = this.patchHtml(html);
    return this.panel;
  }

  get visibleKey() {
    return this.panel ? this.currentKey : "";
  }

  reveal() {
    if (this.panel) {
      this.panel.reveal(ProblemPanel.viewColumn(), true);
    }
  }
}

module.exports = {
  PANEL_COMMANDS,
  buildPanelHtml,
  renderPanelSkeleton,
  stripLeadingHeading,
  actionButton,
  ProblemPanel
};
