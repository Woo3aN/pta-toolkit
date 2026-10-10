"use strict";

/**
 * 题目元信息的**统一文案**。
 *
 * 同一批信息要在两个地方展示：
 *   1. 生成到本地的 `problem.md`（创建代码之后看的就是它）
 *   2. 编辑器旁的题目预览面板（创建代码之前也能看）
 *
 * 以前两边各写一套 —— 格式不一样、字段也漏。集中到这里之后，
 * 「创建代码之前」和「之后」看到的就是同一套东西，不会再漂。
 *
 * 版面约定（两个地方都照这个来）：
 *   前面：只放读题真正要用的 —— 时间限制 · 内存限制
 *   后面：「详细信息」—— 题集 / 题型 / 分值 / 难度 / 作者 / 在线地址 / 本地抓取
 */

/** 时限。够 1 秒的顺带换算成秒，免得自己除。 */
function formatLimit(ms) {
  if (!ms && ms !== 0) {
    return "未提供";
  }
  if (ms >= 1000) {
    return `${ms} ms（${(ms / 1000).toFixed(1)} s）`;
  }
  return `${ms} ms`;
}

/** 内存。顺带换算成 MB —— PTA 给的是 KB，65536 这种数一眼看不出多大。 */
function formatMemory(kb) {
  if (!kb && kb !== 0) {
    return "未提供";
  }
  return `${kb} KB（${(kb / 1024).toFixed(1)} MB）`;
}

/** 前面那行「重要信息」。没有就不给这一行，不留空壳。 */
function limitItems(info) {
  const source = info || {};
  const items = [];
  if (source.timeLimit) {
    items.push({ label: "时间限制", value: formatLimit(source.timeLimit) });
  }
  if (source.memoryLimit) {
    items.push({ label: "内存限制", value: formatMemory(source.memoryLimit) });
  }
  return items;
}

/** 后面「详细信息」里的条目。值为空的直接不列。 */
function detailItems(info) {
  const source = info || {};
  const items = [];

  const setId = source.problemSetId === undefined || source.problemSetId === null ? "" : String(source.problemSetId);
  if (source.problemSetName) {
    items.push({
      label: "题集",
      value: setId ? `${source.problemSetName}（${setId}）` : String(source.problemSetName)
    });
  }
  if (source.problemTypeName) {
    items.push({ label: "题型", value: String(source.problemTypeName) });
  }
  if (source.score !== undefined && source.score !== null && source.score !== "") {
    items.push({ label: "分值", value: String(source.score) });
  }
  // 难度：PTA 的作业题基本恒为 0，0 就不列了，免得占一行没信息量
  if (source.difficulty) {
    items.push({ label: "难度", value: String(source.difficulty) });
  }
  if (source.author) {
    items.push({ label: "作者 / 来源", value: String(source.author) });
  }
  if (source.url) {
    items.push({ label: "在线地址", value: String(source.url) });
  }
  if (source.fetchedAt) {
    items.push({ label: "本地抓取", value: String(source.fetchedAt) });
  }
  return items;
}

/** 前面那行「时限 · 内存」的纯文本形态（Markdown 引用、面板那一行都用它拼）。 */
function limitsText(info) {
  return limitItems(info)
    .map((item) => `${item.label} ${item.value}`)
    .join(" · ");
}

module.exports = {
  formatLimit,
  formatMemory,
  limitItems,
  detailItems,
  limitsText
};
