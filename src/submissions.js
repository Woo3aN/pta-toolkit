"use strict";

/**
 * 提交记录的处理逻辑（不依赖 vscode，方便单测）。
 *
 * PTA 的 `GET /api/problem-sets/{psID}/submissions` 已实测：
 *   - 返回 `{ submissions, hasBefore, problemSetProblemById, ... }`，按时间倒序；
 *   - 游标分页：`before` 传上一页最后一条的 id，两页不重叠；
 *   - `total` 恒为 0，不能用它算页数；
 *   - ⚠️ 按题过滤的参数（problem_set_problem_id / problemSetProblemId）会被服务端忽略，
 *     所以「某道题的提交记录」只能在本地过滤，见 filterSubmissions。
 *
 * 单条字段：id / userId / problemType / problemSetProblemId / submitAt /
 *          status / score / compiler / time（秒）/ memory（字节）/ judgeAt
 */

const submit = require("./submit");

/** 按题、按用户过滤提交记录 */
function filterSubmissions(list, options) {
  const opts = options || {};
  return (list || []).filter((item) => {
    if (!item) {
      return false;
    }
    if (opts.problemId && String(item.problemSetProblemId) !== String(opts.problemId)) {
      return false;
    }
    if (opts.userId && String(item.userId) !== String(opts.userId)) {
      return false;
    }
    return true;
  });
}

/** 时间倒序（PTA 本来就是倒序，这里再保一次底） */
function sortBySubmitAtDesc(list) {
  return (list || [])
    .slice()
    .sort((a, b) => String((b && b.submitAt) || "").localeCompare(String((a && a.submitAt) || "")));
}

/** 去重（分页拉取时可能因为新提交而重叠） */
function dedupeById(list) {
  const seen = new Set();
  const result = [];
  (list || []).forEach((item) => {
    if (!item || !item.id || seen.has(String(item.id))) {
      return;
    }
    seen.add(String(item.id));
    result.push(item);
  });
  return result;
}

/** 列表里每一行显示什么 */
function describeSubmission(item) {
  const source = item || {};
  return {
    label: `${submit.statusText(source.status)}  ${submit.formatScore(source.score)} 分`,
    description: [
      submit.formatTime(source.time),
      submit.formatMemory(source.memory),
      submit.formatSubmitAt(source.submitAt)
    ]
      .filter(Boolean)
      .join(" · "),
    detail: [source.compiler, source.id ? `提交 ID ${source.id}` : ""].filter(Boolean).join(" · ")
  };
}

module.exports = {
  filterSubmissions,
  sortBySubmitAtDesc,
  dedupeById,
  describeSubmission
};
