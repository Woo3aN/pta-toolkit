"use strict";

/**
 * 侧边栏的题目集树 —— 相当于把 https://pintia.cn/problem-sets/active 搬进 VS Code。
 *
 *   我的题集  →  题集  →  题目（带做题状态图标，点击打开题面）
 *   收藏夹    →  题目
 *   公开题集  →  题集  →  题目
 *
 * 题目列表是按需加载的（展开题集时才请求），并在一次会话内缓存；
 * 本地已有的题目会直接显示状态与「已下载」标记。
 */

const vscode = require("vscode");
const path = require("path");

const api = require("./ptaApi");
const library = require("./library");
const treeModel = require("./treeModel");
const ws = require("./problemWorkspace");

const GROUP_MINE = "mine";
const GROUP_FAVORITES = "favorites";
const GROUP_PUBLIC = "public";

function messageItem(text, icon) {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.kind = "message";
  item.contextValue = "pta.message";
  item.iconPath = new vscode.ThemeIcon(icon || "info");
  return item;
}

/** 顶部的「请登录 / 登录已过期」条目，点一下就去登录。 */
function loginItem(text, expired) {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.kind = "message";
  item.contextValue = "pta.login";
  item.iconPath = new vscode.ThemeIcon(expired ? "warning" : "account");
  item.tooltip = expired ? "会话已失效，点这里重新登录" : "点这里登录拼题A（微信扫码）";
  item.command = { command: "pta.login", title: "登录" };
  return item;
}

function groupItem(group, label, icon, tooltip) {  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
  item.kind = "group";
  item.group = group;
  item.contextValue = "pta.group";
  item.iconPath = new vscode.ThemeIcon(icon);
  item.tooltip = tooltip;
  return item;
}

function themeColorOrUndefined(status) {
  const id = treeModel.problemThemeColorId(status);
  return id ? new vscode.ThemeColor(id) : undefined;
}

class PtaTreeDataProvider {
  constructor(options) {
    const opts = options || {};
    this.getCookie = opts.getCookie || (async () => "");
    this.getWorkspaceRoot = opts.getWorkspaceRoot || (async () => "");
    this.isAuthExpired = opts.isAuthExpired || (() => false);
    this.onAuthError = opts.onAuthError || (() => {});
    this.log = opts.log || (() => {});
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.problemCache = new Map();
  }

  refresh() {
    this.problemCache.clear();
    this.emitter.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    try {
      if (!element) {
        return this.rootGroups();
      }
      if (element.kind === "group") {
        return await this.groupChildren(element.group);
      }
      if (element.kind === "set") {
        return await this.setChildren(element);
      }
      return [];
    } catch (error) {
      this.log(`侧边栏加载失败：${error && error.message ? error.message : error}`);
      if (api.isAuthError(error)) {
        // 顺手把「登录已过期」记下来，顶部就会一直提示
        this.onAuthError();
        return [messageItem("登录已失效，点标题栏的登录按钮重新登录", "warning")];
      }
      return [messageItem(`加载失败：${error && error.message ? error.message : error}`, "error")];
    }
  }

  async rootGroups() {
    const items = [];
    // 长时间不用，PTA 会把会话回收掉。这里在「账号」那一栏一直提示，
    // 而不是等他点开题集、报错了才知道。
    const expired = Boolean(await this.isAuthExpired());
    const cookie = await this.getCookie();
    if (expired) {
      items.push(loginItem("登录已过期，请重新登录", true));
    } else if (!cookie) {
      items.push(loginItem("请登录（微信扫码）", false));
    }
    items.push(
      groupItem(GROUP_MINE, "我的题集", "account", "你已加入的题目集（含老师布置的）"),
      groupItem(GROUP_FAVORITES, "收藏夹", "star", "本地收藏的题目"),
      groupItem(GROUP_PUBLIC, "公开题集", "library", "无需登录即可浏览的题目集")
    );
    return items;
  }

  async groupChildren(group) {
    if (group === GROUP_FAVORITES) {
      return this.favoriteChildren();
    }
    const cookie = await this.getCookie();
    if (!cookie) {
      return [messageItem("登录后即可浏览，点标题栏的登录按钮", "account")];
    }
    if (group === GROUP_PUBLIC) {
      return this.publicChildren();
    }
    return this.mineChildren(cookie);
  }

  async mineChildren(cookie) {
    const active = await api.getMyProblemSets(cookie, { onlyActive: true });
    const all = await api.getMyProblemSets(cookie, { onlyActive: false });
    const map = new Map();
    all.forEach((item) => map.set(item.id, item));
    active.forEach((item) => map.set(item.id, item));
    const list = Array.from(map.values());
    if (!list.length) {
      return [messageItem("没有读到你的题集", "info")];
    }
    return list.map((item) => this.setItem(item, {}));
  }

  async publicChildren() {
    const list = await api.getAlwaysAvailableProblemSets();
    if (!list.length) {
      return [messageItem("没有读到公开题集", "info")];
    }
    return list.map((item) => this.setItem(item, { isPublic: true }));
  }

  async favoriteChildren() {
    const root = await this.getWorkspaceRoot();
    const items = await library.listFavorites(root);
    if (!items.length) {
      return [messageItem("收藏夹是空的（题目上右键可以收藏）", "star")];
    }
    return items.map((item) => {
      const problem = {
        id: item.problemId,
        label: item.label,
        title: item.title,
        type: item.problemType,
        score: item.score
      };
      return this.problemItem(problem, {
        problemSetId: item.problemSetId,
        problemSetName: item.problemSetName,
        isFavorite: true
      });
    });
  }

  setItem(problemSet, extra) {
    const opts = extra || {};
    const item = new vscode.TreeItem(
      problemSet.name || problemSet.id,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.kind = "set";
    item.contextValue = opts.isPublic ? "pta.set.public" : "pta.set";
    item.setRef = {
      problemSetId: String(problemSet.id),
      problemSetName: problemSet.name || "",
      // 带着展开时用来把「403 没权限」翻译成人话：
      // PTA 对尚未开始 / 已截止的题集就是回 403，得知道是哪一种才能说清楚。
      status: problemSet.status || "",
      endAt: problemSet.endAt || ""
    };
    item.description = treeModel.problemSetDescription(problemSet);
    item.iconPath = new vscode.ThemeIcon(treeModel.problemSetIconId(Object.assign({}, problemSet, opts)));
    const tooltip = [`**${problemSet.name || problemSet.id}**`, `题集 ID：${problemSet.id}`];
    if (problemSet.organizationName) {
      tooltip.push(`来源：${problemSet.organizationName}`);
    }
    if (problemSet.endAt) {
      tooltip.push(treeModel.formatDeadline(problemSet.endAt));
    }
    tooltip.push("", "展开可看题目；右键可以把整个题集拉到本地");
    item.tooltip = tooltip.join("\n\n");
    return item;
  }

  problemItem(problem, options) {
    const opts = options || {};
    const item = new vscode.TreeItem(
      treeModel.problemNodeLabel(problem),
      vscode.TreeItemCollapsibleState.None
    );
    item.kind = "problem";
    item.contextValue = opts.isFavorite ? "pta.problem.favorite" : "pta.problem";
    item.ref = {
      problemSetId: String(opts.problemSetId),
      problemSetName: opts.problemSetName || "",
      problemId: String(problem.id || problem.problemId),
      label: problem.label || "",
      title: problem.title || "",
      problemType: problem.type || "PROGRAMMING",
      score: problem.score === undefined ? null : problem.score
    };
    item.description = treeModel.problemNodeDescription(problem, opts.status);
    item.iconPath = new vscode.ThemeIcon(
      treeModel.problemIconId(opts.status),
      themeColorOrUndefined(opts.status)
    );
    item.tooltip = new vscode.MarkdownString(
      treeModel.problemTooltipLines(problem, {
        problemSetName: opts.problemSetName,
        status: opts.status,
        local: opts.local
      })
    );
    item.command = {
      command: "pta.previewProblem",
      title: "预览题目",
      arguments: [item.ref]
    };
    return item;
  }

  /** 读本地 .pta.json，拿到每道题的做题状态与「是否已下载」 */
  async localState(problemSetId) {
    const state = { statusById: new Map(), localIds: new Set(), favorites: new Set() };
    const root = await this.getWorkspaceRoot();
    if (!root) {
      return state;
    }
    const setDir = await library.findLocalProblemSetDir(root, problemSetId);
    if (setDir) {
      const entries = await ws.readProblemSetEntries(setDir);
      for (const entry of entries) {
        const id = String(entry.metadata.problemId);
        state.localIds.add(id);
        if (entry.metadata.problemStatus) {
          state.statusById.set(id, entry.metadata.problemStatus);
        }
      }
    }
    const favorites = await library.listFavorites(root);
    favorites.forEach((item) => state.favorites.add(`${item.problemSetId}:${item.problemId}`));
    return state;
  }

  async setChildren(element) {
    const cookie = await this.getCookie();
    if (!cookie) {
      return [messageItem("登录后才能展开题集内容", "account")];
    }
    const problemSetId = element.setRef.problemSetId;
    const problemSetName = element.setRef.problemSetName;

    let problems = this.problemCache.get(problemSetId);
    if (!problems) {
      let collected;
      try {
        const summaries = await api.getProblemSummary(problemSetId, cookie);
        const types = Object.keys(summaries).filter((type) => api.SAMPLE_BEARING_TYPES.indexOf(type) >= 0);
        if (!types.length) {
          return [messageItem("这个题集里没有可导出的编程题", "info")];
        }
        collected = [];
        for (const type of types) {
          const list = await api.getAllProblems(problemSetId, type, cookie, { interval: 0 });
          collected = collected.concat(list);
        }
      } catch (error) {
        // PTA 对「尚未开始」和「已经截止」的题集统一回 403：这是正常状态，不是加载故障。
        // 所以给一句人能看懂的话，别甩一个红叉加原始错误串。
        if (treeModel.isForbiddenError(error)) {
          return [messageItem(treeModel.forbiddenProblemSetMessage(element.setRef), "lock")];
        }
        throw error;
      }
      problems = collected;
      this.problemCache.set(problemSetId, problems);
    }
    if (!problems.length) {
      return [messageItem("这个题集没有读到题目", "info")];
    }

    const state = await this.localState(problemSetId);
    return problems.map((problem) =>
      this.problemItem(problem, {
        problemSetId,
        problemSetName,
        status: state.statusById.get(String(problem.id)),
        local: state.localIds.has(String(problem.id)),
        isFavorite: state.favorites.has(`${problemSetId}:${problem.id}`)
      })
    );
  }
}

module.exports = {
  PtaTreeDataProvider,
  GROUP_MINE,
  GROUP_FAVORITES,
  GROUP_PUBLIC,
  VIEW_ID: "pta.problemSets"
};
