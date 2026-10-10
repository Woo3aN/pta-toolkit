"use strict";

/**
 * 提交代码 / 在线测试（自定义测试数据），并轮询判题结果。
 * 流程与 PTA 前端一致：
 *   1. 取 examID（没有则 POST 建一个；自己建的题集建不了）
 *   2. POST /api/exams/{examId}/submissions
 *   3. 每秒轮询 /api/submissions/{id}（在线测试多带 custom_test_data_submission=true）
 *      直到 queued === -1 且状态不是 WAITING / JUDGING
 */

const api = require("./ptaApi");

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120000;

async function pollResult(submissionId, cookie, isTest, onProgress) {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await api.sleep(POLL_INTERVAL_MS);
    let data;
    try {
      data = isTest
        ? await api.getTestResult(submissionId, cookie)
        : await api.getSubmissionResult(submissionId, cookie);
    } catch (error) {
      if (error && error.kind === "notfound") {
        continue;
      }
      throw error;
    }
    const submission = data && data.submission;
    if (!submission) {
      continue;
    }
    const status = submission.status || "";
    if (status !== lastStatus) {
      lastStatus = status;
      if (onProgress) {
        onProgress(api.submissionStatusText(status));
      }
    }
    if (data.queued === -1 && status !== "WAITING" && status !== "JUDGING") {
      return { data, submissionId };
    }
  }
  throw new api.PtaError("等待判题超时（超过 2 分钟）。可在 PTA 网站上查看本次提交结果。", "timeout");
}

async function sendSubmission(options) {
  const opts = options || {};
  const { examId } = await api.ensureExamId(opts.problemSetId, opts.cookie);
  const detail = api.buildSubmissionDetail({
    problemSetProblemId: opts.problemId,
    problemType: opts.problemType,
    compiler: opts.compiler,
    program: opts.program,
    testInput: opts.testInput
  });
  const result = await api.submitSolution(examId, opts.cookie, {
    details: [detail],
    problemType: opts.problemType
  });
  if (!result || !result.submissionId) {
    const detailText = result && result.error ? JSON.stringify(result.error) : "PTA 没有返回 submissionId";
    throw new api.PtaError(`提交失败：${detailText}`, "submit");
  }
  return result.submissionId;
}

/** 正式提交（计入成绩），返回 { data, submissionId } */
async function submitSolution(options) {
  const submissionId = await sendSubmission(options);
  return pollResult(submissionId, options.cookie, false, options.onProgress);
}

/** 在线测试：用自定义测试数据跑一次，不计入成绩 */
async function testSolution(options) {
  const submissionId = await sendSubmission(options);
  return pollResult(submissionId, options.cookie, true, options.onProgress);
}

/* ------------------------------------------------------------------ */
/* 结果整理                                                            */
/* ------------------------------------------------------------------ */

function pickJudgeContent(submission) {
  const contents = (submission && submission.judgeResponseContents) || [];
  for (const content of contents) {
    const programming = content.programmingJudgeResponseContent || content.codeCompletionJudgeResponseContent;
    if (programming) {
      return programming;
    }
  }
  return null;
}

function statusText(status) {
  return api.submissionStatusText(status);
}

/**
 * PTA 的提交记录里 `time` 单位是**秒**、`memory` 单位是**字节**，
 * 而题目里的 timeLimit / memoryLimit 才是毫秒 / KB。
 * 这几个格式化函数统一放在这里，避免各处自己猜单位。
 */
function formatTime(seconds) {
  if (seconds === undefined || seconds === null || seconds === "") {
    return "";
  }
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return String(seconds);
  }
  return `${(value * 1000).toFixed(0)} ms`;
}

function formatMemory(bytes) {
  if (bytes === undefined || bytes === null || bytes === "") {
    return "";
  }
  const value = Number(bytes);
  if (!Number.isFinite(value)) {
    return String(bytes);
  }
  return `${(value / 1024).toFixed(0)} KB`;
}

function formatScore(score) {
  if (score === undefined || score === null || score === "") {
    return "";
  }
  const value = Number(score);
  if (!Number.isFinite(value)) {
    return String(score);
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function formatSubmitAt(submitAt) {
  if (!submitAt) {
    return "";
  }
  return String(submitAt).replace("T", " ").replace("Z", "").slice(0, 19);
}

/** 生成一段人能读的结果报告（写进输出通道） */
function buildReport(result, meta) {
  const data = result && result.data ? result.data : {};
  const submission = data.submission || {};
  const info = meta || {};
  const lines = [];

  const title = info.isTest ? "在线测试结果" : "提交结果";
  // 自定义测试不计分，PTA 回的状态是 NEUTRAL，照着报等于什么都没说 —— 报测试点更有用
  lines.push(
    info.isTest
      ? `${title}：${shortStatusLine(result, { isTest: true })}`
      : `${title}：${statusText(submission.status)}（${submission.status || "未知"}）`
  );
  if (info.problemTitle) {
    lines.push(`题目：${info.label ? info.label + " " : ""}${info.problemTitle}`);
  }
  if (info.compiler) {
    lines.push(`编译器：${info.compiler}`);
  }
  if (submission.score !== undefined && submission.score !== null) {
    lines.push(`得分：${formatScore(submission.score)}${info.totalScore ? ` / ${formatScore(info.totalScore)}` : ""}`);
  }
  if (submission.time !== undefined && submission.time !== null) {
    lines.push(`耗时：${formatTime(submission.time)}${info.timeLimit ? ` / ${info.timeLimit} ms` : ""}`);
  }
  if (submission.memory !== undefined && submission.memory !== null) {
    lines.push(`内存：${formatMemory(submission.memory)}${info.memoryLimit ? ` / ${info.memoryLimit} KB` : ""}`);
  }
  if (submission.submitAt) {
    lines.push(`提交时间：${formatSubmitAt(submission.submitAt)}`);
  }
  if (result && result.submissionId) {
    lines.push(`提交 ID：${result.submissionId}`);
  }
  lines.push("");

  const judge = pickJudgeContent(submission);
  const compile = judge && judge.compilationResult;
  if (compile && compile.success === false) {
    lines.push("编译错误信息：");
    lines.push((compile.log || compile.error || "").trim() || "（PTA 未返回编译日志）");
    lines.push("");
  }

  const testcases = (judge && judge.testcaseJudgeResults) || null;
  if (testcases) {
    lines.push("测试点：");
    const keys = Object.keys(testcases);
    keys.forEach((key, index) => {
      const item = testcases[key] || {};
      const parts = [`  ${index + 1}. ${statusText(item.result)}`];
      if (item.time !== undefined) {
        parts.push(formatTime(item.time));
      }
      if (item.memory !== undefined) {
        parts.push(formatMemory(item.memory));
      }
      if (item.testcaseScore !== undefined) {
        parts.push(`${formatScore(item.testcaseScore)} 分`);
      }
      lines.push(parts.join("  "));
      if (info.isTest && item.stdout) {
        lines.push("     你的输出：");
        String(item.stdout)
          .replace(/\s+$/, "")
          .split("\n")
          .forEach((line) => lines.push(`       ${line}`));
      }
      if (info.isTest && item.stderr) {
        lines.push("     标准错误：");
        String(item.stderr)
          .replace(/\s+$/, "")
          .split("\n")
          .forEach((line) => lines.push(`       ${line}`));
      }
    });
    lines.push("");
  }

  const hints = submission.hints || {};
  const hintKeys = Object.keys(hints);
  if (hintKeys.length) {
    lines.push("提示：");
    hintKeys.forEach((key) => lines.push(`  ${key}：${hints[key]}`));
    lines.push("");
  }

  if (!compile && !testcases && submission.cause) {
    lines.push(`原因：${submission.cause}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 一句话摘要（通知里用）。
 *
 * 自定义测试（在线测试）不能只报 submission.status —— PTA 对这类不计分的提交回的是
 * NEUTRAL，显示成「测试结果：NEUTRAL」等于什么都没说。所以这里改成报测试点的情况：
 * 有几个点、跑没跑通。编译失败优先报编译错误。
 */
function shortStatusLine(result, options) {
  const opts = options || {};
  const data = (result && result.data) || {};
  const submission = data.submission || {};
  const judge = pickJudgeContent(submission);
  const compile = judge && judge.compilationResult;

  if (compile && compile.success === false) {
    return "编译错误";
  }

  const testcases = (judge && judge.testcaseJudgeResults) || null;
  const keys = testcases ? Object.keys(testcases) : [];

  if (opts.isTest) {
    if (keys.length) {
      // 自定义测试没有标准答案，逐点报「答案正确」没意义，只看有没有异常
      const abnormal = keys.filter((key) => {
        const item = testcases[key] || {};
        return item.result && item.result !== "ACCEPTED";
      });
      if (abnormal.length) {
        const reasons = abnormal.map((key) => statusText((testcases[key] || {}).result));
        return `${keys.length} 个测试点，${abnormal.length} 个异常（${reasons.join("、")}）`;
      }
      return `${keys.length} 个测试点，全部运行正常`;
    }
    return `${statusText(submission.status)}（自定义测试不计分）`;
  }

  const score =
    submission.score === undefined || submission.score === null ? "" : `，得分 ${formatScore(submission.score)}`;
  return `${statusText(submission.status)}${score}`;
}

module.exports = {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  submitSolution,
  testSolution,
  buildReport,
  shortStatusLine,
  statusText,
  formatTime,
  formatMemory,
  formatScore,
  formatSubmitAt
};
