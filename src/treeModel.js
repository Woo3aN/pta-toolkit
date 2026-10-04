"use strict";

/**
 * 侧边栏树节点的「展示逻辑」（不依赖 vscode，方便单测）。
 */

const api = require("./ptaApi");

/** 题集状态 → 中文（取自 PTA 前端的 ProblemSetExamStatus） */
const SET_STATUS_TEXT = {
  PENDING: "未开始",
  READY: "准备答题中",
  PROCESSING: "进行中",
  END: "已结束"
};

const SET_TYPE_ICON = {
  BOOK: "book",
  EXAM: "checklist",
  SET: "folder"
};

/** 做题状态 → codicon 图标名 */
function problemIconId(status) {
  if (status === "PROBLEM_ACCEPTED") {
    return "pass-filled";
  }
  if (status === "PROBLEM_WRONG_ANSWER") {
    return "close";
  }
  return "circle-outline";
}

/**
 * 做题状态 → VS Code 主题色 id。
 * 用编辑器自带的「测试通过 / 失败」配色，跟随主题，不写死颜色。
 */
function problemThemeColorId(status) {
  if (status === "PROBLEM_ACCEPTED") {
    return "testing.iconPassed";
  }
  if (status === "PROBLEM_WRONG_ANSWER") {
    return "testing.iconFailed";
  }
  return null;
}

function problemSetStatusText(status) {
  if (!status) {
    return "";
  }
  return SET_STATUS_TEXT[status] || status;
}

function formatDeadline(endAt) {
  if (!endAt) {
    return "";
  }
  return `截止 ${String(endAt).slice(0, 16).replace("T", " ")}`;
}

/** 题集节点右侧的灰字 */
function problemSetDescription(item) {
  const source = item || {};
  return [problemSetStatusText(source.status), formatDeadline(source.endAt)].filter(Boolean).join(" · ");
}

/** 题集节点图标 */
function problemSetIconId(item) {
  const source = item || {};
  if (source.isPublic) {
    return "library";
  }
  if (source.type === "BOOK") {
    return "book";
  }
  return SET_TYPE_ICON[source.type] || "folder";
}

/** 题目节点标题：题号 + 标题 */
function problemNodeLabel(problem) {
  const source = problem || {};
  const label = source.label ? `${source.label} ` : "";
  return `${label}${source.title || ""}`.trim() || String(source.id || source.problemId || "未命名题目");
}

/** 题目节点右侧的灰字：状态 + 分值 */
function problemNodeDescription(problem, status) {
  const source = problem || {};
  const parts = [];
  if (status) {
    parts.push(api.problemStatusShort(status));
  }
  if (source.score !== undefined && source.score !== null) {
    parts.push(`${source.score} 分`);
  }
  return parts.join(" · ");
}

function problemTooltipLines(problem, options) {
  const source = problem || {};
  const opts = options || {};
  const lines = [`**${problemNodeLabel(source)}**`];
  if (opts.problemSetName) {
    lines.push(`题集：${opts.problemSetName}`);
  }
  if (source.type) {
    lines.push(`题型：${api.problemTypeName(source.type)}`);
  }
  if (opts.status) {
    lines.push(`状态：${api.problemStatusText(opts.status)}`);
  }
  lines.push("");
  lines.push(opts.local ? "已在本地，点击打开题面" : "还没拉到本地，点击后可以选择拉取");
  return lines.join("\n\n");
}

module.exports = {
  SET_STATUS_TEXT,
  problemIconId,
  problemThemeColorId,
  problemSetStatusText,
  formatDeadline,
  problemSetDescription,
  problemSetIconId,
  problemNodeLabel,
  problemNodeDescription,
  problemTooltipLines
};
