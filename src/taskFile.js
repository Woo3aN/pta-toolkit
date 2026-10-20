"use strict";

/**
 * `.vscode/tasks.json` 的读写。
 *
 * 单独成文件、不依赖 vscode，是为了能单测 —— 这段逻辑出过一个
 * 「tasks.json 里有注释就把用户已有的任务整份清掉」的 bug，必须有回归测试守着。
 *
 * 两条铁律：
 *   1. 文件不存在 → 用空骨架新建；
 *      读出来但解析不了（VS Code 允许在 tasks.json 里写注释，JSON.parse 不认）
 *      → **抛错 / 返回失败**，绝不假装它是空文件。
 *   2. 写回时沿用原文件的缩进，也不丢 `inputs` 之类的其它顶层键。
 */

const fs = require("fs");
const atomicWrite = require("./atomicWrite");

const DEFAULT_VERSION = "2.0.0";
const DEFAULT_INDENT = "  ";

/** 从现有文本里猜缩进（纯观感，免得把用户的 4 空格排版改成 2 空格）。 */
function detectIndent(text) {
  const match = /^([ \t]+)"/m.exec(String(text === null || text === undefined ? "" : text));
  return match ? match[1] : DEFAULT_INDENT;
}

/**
 * 解析现有 tasks.json 的文本。
 * text 为 null / undefined（文件不存在）时返回空骨架的 data。
 * 解析失败一律抛错。
 */
function parseTasksFile(text) {
  if (text === null || text === undefined) {
    return { data: null, indent: DEFAULT_INDENT };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `不是合法 JSON（${error.message}）。VS Code 的 tasks.json 允许写注释，` +
        "但这里没法安全地只改一部分，所以拒绝动它"
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("顶层不是一个 JSON 对象");
  }
  return { data, indent: detectIndent(text) };
}

/** 把 tasks 数组读出来（顶层没有 tasks 就当空数组）。 */
function tasksOf(data) {
  return data && Array.isArray(data.tasks) ? data.tasks : [];
}

/** 序列化回文本：沿用原缩进，末尾留一个换行。 */
function serializeTasksFile(data, indent) {
  // 复制一份再改，键的顺序（version 在前、tasks 在后、inputs 等保持在原位）就不会被打乱
  const payload = Object.assign({}, data);
  payload.version = payload.version || DEFAULT_VERSION;
  payload.tasks = tasksOf(data);
  return `${JSON.stringify(payload, null, indent || DEFAULT_INDENT)}\n`;
}

/**
 * 把新任务合并进现有内容，返回新的文本。
 *
 * options.replaceKeys：label 里含这些字符串的旧任务会被丢掉。
 *   同一道题重拉时用它做替换，免得任务列表里堆一堆同名条目。
 */
function mergeTasks(text, newTasks, options) {
  const opts = options || {};
  const parsed = parseTasksFile(text);
  const data = parsed.data || { version: DEFAULT_VERSION, tasks: [] };
  const keys = (opts.replaceKeys || []).filter(Boolean);
  const existing = tasksOf(data);

  const kept = keys.length
    ? existing.filter((task) => {
        const label = String((task && task.label) || "");
        return !keys.some((key) => label.indexOf(key) >= 0);
      })
    : existing;

  const merged = Object.assign({}, data, {
    version: data.version || DEFAULT_VERSION,
    tasks: kept.concat(newTasks || [])
  });

  return {
    text: serializeTasksFile(merged, parsed.indent),
    indent: parsed.indent,
    keptCount: kept.length,
    replacedCount: existing.length - kept.length,
    totalCount: merged.tasks.length
  };
}

/**
 * 读现有文件 → 合并 → 写回。
 *
 * 解析失败时**不写**，把原因返回给调用方（而不是抛出去打断整轮拉题，
 * 也不是默默覆盖）。返回 { ok: true, ... } 或 { ok: false, reason }。
 */
async function mergeTasksFile(tasksPath, newTasks, options) {
  let existing = null;
  try {
    existing = await fs.promises.readFile(tasksPath, "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
    /* 没有这个文件：用空骨架新建 */
  }

  let merged;
  try {
    merged = mergeTasks(existing, newTasks, options);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  // 这里写的是用户仓库里的 .vscode/tasks.json，写坏会直接影响编辑器，必须原子写
  await atomicWrite.writeFileAtomic(tasksPath, merged.text);
  return Object.assign({ ok: true }, merged);
}

module.exports = {
  DEFAULT_VERSION,
  DEFAULT_INDENT,
  detectIndent,
  parseTasksFile,
  serializeTasksFile,
  mergeTasks,
  mergeTasksFile
};
