"use strict";

/**
 * PTA（拼题A / pintia.cn）接口层。
 *
 * 这里是唯一需要随着 PTA 改接口而修改的文件。
 * 已实测的契约（2026-10-04）：
 *   - 请求头只需 Cookie: PTASession=<值> + Accept/Content-Type: application/json;charset=UTF-8
 *     + Accept-Language: zh-CN，不需要 x-lollipop 动态签名。
 *   - 未登录 / Cookie 失效 / 无权访问 → HTTP 406，body 为空。
 *   - 题面接口返回的 description 本身就是 Markdown 文本（不是 HTML）。
 *   - 题目列表用 exam-problem-list；problem-list 那条路径恒返回 406，不要用。
 */

const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");
const compilers = require("./compilers");

const ORIGIN = "https://pintia.cn";
const PASSPORT_ORIGIN = "https://passport.pintia.cn";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** 题型 → PTA 内部 type id（用于拼出可在浏览器打开的题目链接） */
const PROBLEM_TYPE_INFO = {
  TRUE_OR_FALSE: { name: "判断题", type: 1 },
  MULTIPLE_CHOICE: { name: "单选题", type: 2 },
  FILL_IN_THE_BLANK_FOR_PROGRAMMING: { name: "程序填空题", type: 5 },
  CODE_COMPLETION: { name: "函数题", type: 6 },
  PROGRAMMING: { name: "编程题", type: 7 },
  MULTIPLE_FILE: { name: "多文件编程题", type: 9 }
};

/** 有结构化题面与样例的题型 */
const SAMPLE_BEARING_TYPES = ["PROGRAMMING", "CODE_COMPLETION"];

class PtaError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = "PtaError";
    this.kind = kind || "unknown";
    this.status = status;
  }
}

function isAuthError(error) {
  return Boolean(error) && (error.kind === "auth" || error.status === 406 || error.status === 401);
}

function decodeBody(buffer, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) {
      return zlib.brotliDecompressSync(buffer).toString("utf8");
    }
    if (enc.includes("gzip")) {
      return zlib.gunzipSync(buffer).toString("utf8");
    }
    if (enc.includes("deflate")) {
      return zlib.inflateSync(buffer).toString("utf8");
    }
  } catch (_error) {
    /* 解压失败就按原文处理 */
  }
  return buffer.toString("utf8");
}

function describeHttpFailure(status, text) {
  const body = String(text || "").trim();
  // PTA 的错误体是结构化的：{"error":{"code":"...","message":"..."}}
  let detail = "";
  let code = "";
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.error && parsed.error.message) {
      detail = parsed.error.message;
      code = parsed.error.code || "";
    } else if (parsed && parsed.message) {
      detail = parsed.message;
    }
  } catch (_error) {
    /* 不是 JSON */
  }

  if (status === 406) {
    return new PtaError(
      "PTA 返回 406：登录状态无效，或你没有这个题集的访问权限。请重新执行「PTA: 登录」。",
      "auth",
      406
    );
  }
  if (status === 401 || code === "USER_NOT_LOGGED_IN") {
    // 需要登录的接口（题目状态、签到、提交历史）走这里
    const error = new PtaError(detail || "PTA 返回 401：需要登录。", "auth", 401);
    error.code = code;
    return error;
  }
  if (status === 403) {
    return new PtaError("PTA 返回 403：没有权限（题集可能尚未开始、已结束或未对你开放）。", "forbidden", 403);
  }
  if (status === 404) {
    return new PtaError("PTA 返回 404：题集或题目不存在。", "notfound", 404);
  }
  if (body.startsWith("<")) {
    return new PtaError(
      `PTA 返回的是网页而不是数据（HTTP ${status}）。多半是接口变了，或需要重新登录。可执行「PTA: 诊断」看原始响应。`,
      "unexpected-html",
      status
    );
  }
  const error = new PtaError(
    `PTA 请求失败（HTTP ${status}）${detail || body.slice(0, 200)}`,
    "http",
    status
  );
  error.code = code;
  return error;
}

/**
 * 单次 HTTP 请求（带 gzip/br 解压、重定向跟随、超时）。
 * 不用 Node 的 fetch，是为了完全掌控请求头 —— PTA 对头部比较挑。
 */
function rawRequest(rawUrl, options) {
  const opts = options || {};
  const method = opts.method || "GET";
  const cookie = opts.cookie || "";
  const timeout = opts.timeout || 25000;
  const redirectLeft = opts.redirectLeft === undefined ? 4 : opts.redirectLeft;

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(rawUrl);
    } catch (_error) {
      reject(new PtaError(`URL 不合法：${rawUrl}`, "invalid"));
      return;
    }

    const headers = {
      Accept: "application/json;charset=UTF-8",
      "Content-Type": "application/json;charset=UTF-8",
      "Accept-Language": "zh-CN",
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": BROWSER_UA,
      // 登录相关的接口在 passport 子域上，Referer/Origin 跟着目标域名走
      Referer: `${target.origin}/`,
      Origin: target.origin
    };
    if (cookie) {
      headers.Cookie = cookie;
    }

    let payload;
    if (opts.body !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.body), "utf8");
      headers["Content-Length"] = payload.length;
    } else if (method === "POST") {
      // PTA 的建考试接口是无 body 的 POST，补上 Content-Length: 0
      payload = Buffer.alloc(0);
      headers["Content-Length"] = 0;
    }

    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          const text = decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]);

          if (status >= 300 && status < 400 && res.headers.location && redirectLeft > 0) {
            const next = new URL(res.headers.location, target).toString();
            resolve(
              rawRequest(next, Object.assign({}, opts, { redirectLeft: redirectLeft - 1 }))
            );
            return;
          }

          if (status === 200 || status === 412) {
            resolve({ status, text, headers: res.headers });
            return;
          }
          reject(describeHttpFailure(status, text));
        });
      }
    );

    req.setTimeout(timeout, () => {
      req.destroy(new PtaError(`请求超时（${timeout}ms）：${rawUrl}`, "timeout"));
    });
    req.on("error", (error) => {
      if (error instanceof PtaError) {
        reject(error);
        return;
      }
      reject(new PtaError(`网络请求失败：${error.message}`, "network"));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function requestJson(rawUrl, options) {
  const opts = options || {};
  const attempts = opts.retries === undefined ? 2 : opts.retries;
  let lastError;
  for (let i = 0; i <= attempts; i += 1) {
    try {
      const response = await rawRequest(rawUrl, opts);
      const text = String(response.text || "").trim();
      if (!text) {
        if (response.status === 412) {
          return {};
        }
        throw new PtaError(`PTA 返回了空响应（HTTP ${response.status}）。`, "empty", response.status);
      }
      try {
        return JSON.parse(text);
      } catch (_error) {
        throw new PtaError(
          "PTA 返回的内容不是 JSON（接口可能已变更）。可执行「PTA: 诊断」查看原始响应。",
          "parse",
          response.status
        );
      }
    } catch (error) {
      lastError = error;
      const retriable = error && (error.kind === "network" || error.kind === "timeout");
      if (!retriable || i === attempts) {
        throw error;
      }
      await sleep(800 * (i + 1));
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* 业务接口                                                            */
/* ------------------------------------------------------------------ */

/** 校验 Cookie 是否有效，并拿到当前用户。 */
async function getCurrentUser(cookie) {
  const json = await requestJson(`${PASSPORT_ORIGIN}/api/u/current`, { cookie });
  return json && json.user ? json.user : null;
}

/**
 * 我的题集（含老师布置、带 deadline 的题集）。
 * filter 传 { endAtAfter: ISO } 只要尚未结束的；传 {} 取全部。
 */
async function getMyProblemSets(cookie, options) {
  const opts = options || {};
  const filter = opts.onlyActive ? { endAtAfter: new Date().toISOString() } : {};
  const url = `${ORIGIN}/api/problem-sets?filter=${encodeURIComponent(JSON.stringify(filter))}`;
  const json = await requestJson(url, { cookie });
  return json.problemSets || [];
}

/** 公开题集（无需登录） */
async function getAlwaysAvailableProblemSets() {
  const json = await requestJson(`${ORIGIN}/api/problem-sets/always-available`);
  const summariesById = json.problemSetSummaryByProblemSetId || {};
  const problemSets = json.problemSets || [];
  return problemSets.map((item) => {
    const bundle = summariesById[item.id];
    const summaries =
      (bundle &&
        bundle.summariesByPaperIndex &&
        bundle.summariesByPaperIndex[0] &&
        bundle.summariesByPaperIndex[0].summaryByProblemType) ||
      null;
    return Object.assign({}, item, { summaries });
  });
}

/** 题集元信息：名称、编译器列表、权限、状态 */
async function getProblemSetInfo(problemSetId, cookie) {
  return requestJson(`${ORIGIN}/api/problem-sets/${problemSetId}/exams`, { cookie });
}

/** 各题型的题量统计：{ PROGRAMMING: { total, totalScore }, ... } */
async function getProblemSummary(problemSetId, cookie) {
  const json = await requestJson(`${ORIGIN}/api/problem-sets/${problemSetId}/problem-summaries`, { cookie });
  return (json && json.summaries) || {};
}

/** 某一题型的题目列表（分页，limit 上限 200） */
async function getProblemListPage(problemSetId, problemType, page, limit, cookie) {
  const query = `problem_type=${encodeURIComponent(problemType)}&page=${page}&limit=${limit}`;
  const json = await requestJson(
    `${ORIGIN}/api/problem-sets/${problemSetId}/exam-problem-list?${query}`,
    { cookie }
  );
  return {
    total: json.total || 0,
    problems: json.problemSetProblems || []
  };
}

/** 拉取一个题型的全部题目 */
async function getAllProblems(problemSetId, problemType, cookie, options) {
  const opts = options || {};
  const interval = opts.interval === undefined ? 600 : opts.interval;
  const limit = 200;
  const first = await getProblemListPage(problemSetId, problemType, 0, limit, cookie);
  const problems = first.problems.slice();
  const pageCount = Math.ceil(first.total / limit);
  for (let page = 1; page < pageCount; page += 1) {
    if (interval > 0) {
      await sleep(interval);
    }
    if (opts.shouldCancel && opts.shouldCancel()) {
      break;
    }
    const next = await getProblemListPage(problemSetId, problemType, page, limit, cookie);
    if (!next.problems.length) {
      break;
    }
    problems.push(...next.problems);
  }
  return problems;
}

/**
 * 题目详情：题面 + 样例。
 * 返回 problemSetProblem，其中：
 *   description       题面（Markdown 文本）
 *   problemConfig.programmingProblemConfig.exampleTestDatas  [{ name, input, output }]
 *   problemConfig.programmingProblemConfig.{timeLimit, memoryLimit, codeSizeLimit}
 */
async function getProblemDetail(problemSetId, problemId, cookie) {
  const json = await requestJson(
    `${ORIGIN}/api/problem-sets/${problemSetId}/exam-problems/${problemId}`,
    { cookie }
  );
  if (!json || !json.problemSetProblem) {
    throw new PtaError("题目详情返回结构异常（接口可能已变更）。", "shape");
  }
  return json.problemSetProblem;
}

/* ------------------------------------------------------------------ */
/* URL 解析与拼装                                                      */
/* ------------------------------------------------------------------ */

/** 兼容用户从浏览器复制过来的各种链接形态 */
function parsePtaUrl(input) {
  const text = String(input || "").trim();
  const setMatch = text.match(/problem-sets\/(\d+)/);
  if (!setMatch && /^\d+$/.test(text)) {
    return { problemSetId: text, problemId: null };
  }
  if (!setMatch) {
    throw new PtaError("识别不出题集 ID，请复制浏览器地址栏里题集 / 题目的完整链接。", "invalid");
  }
  const problemSetId = setMatch[1];
  let problemId = null;

  const queryMatch = text.match(/problemSetProblemId=(\d+)/);
  if (queryMatch) {
    problemId = queryMatch[1];
  } else {
    const pathMatch = text.match(/problem-sets\/\d+\/(?:exam\/)?problems(?:\/type\/\d+)?\/(\d+)/);
    if (pathMatch) {
      problemId = pathMatch[1];
    }
  }
  return { problemSetId, problemId };
}

function problemTypeId(problemType) {
  const info = PROBLEM_TYPE_INFO[problemType];
  return info ? info.type : 7;
}

function problemTypeName(problemType) {
  const info = PROBLEM_TYPE_INFO[problemType];
  return info ? info.name : problemType;
}

function buildProblemUrl(problemSetId, problemId, problemType) {
  const typeId = problemTypeId(problemType);
  return `${ORIGIN}/problem-sets/${problemSetId}/exam/problems/type/${typeId}?problemSetProblemId=${problemId}`;
}

function buildProblemSetUrl(problemSetId) {
  return `${ORIGIN}/problem-sets/${problemSetId}`;
}

function parseCookieInput(input) {
  const text = String(input || "").trim();
  if (!text) {
    return "";
  }
  const match = text.match(/PTASession=([^;\s]+)/i);
  if (match) {
    return `PTASession=${match[1]}`;
  }
  const compact = text.replace(/^Cookie:\s*/i, "").trim();
  if (/^[^=;\s]+$/.test(compact)) {
    return `PTASession=${compact}`;
  }
  return compact.includes("=") ? compact : `PTASession=${compact}`;
}

/* ------------------------------------------------------------------ */
/* 提交 / 在线测试 / 判题                                              */
/* ------------------------------------------------------------------ */

/** 题集权限。47 = 自己建的题集，PTA 不允许自动创建考试容器。 */
const PROBLEM_PERMISSION = {
  UNKNOWN: -1,
  LOCKED: 9,
  MY_PROBLEM_SET: 47
};

/** PTA 判题状态 → 中文（照 PTA 官方前端用语） */
const SUBMISSION_STATUS_TEXT = {
  OVERRIDDEN: "已被覆盖",
  // NEUTRAL：PTA 对「自定义测试」这种不计分的提交回的状态。
  // 以前这里没有它，所以界面上会原样显示英文 NEUTRAL。
  NEUTRAL: "未评判",
  WAITING: "等待评测",
  JUDGING: "正在评测",
  COMPILE_ERROR: "编译错误",
  ACCEPTED: "答案正确",
  PARTIAL_ACCEPTED: "部分正确",
  PRESENTATION_ERROR: "格式错误",
  WRONG_ANSWER: "答案错误",
  MULTIPLE_ERROR: "多种错误",
  TIME_LIMIT_EXCEEDED: "运行超时",
  MEMORY_LIMIT_EXCEEDED: "内存超限",
  NON_ZERO_EXIT_CODE: "非零返回",
  SEGMENTATION_FAULT: "段错误",
  FLOAT_POINT_EXCEPTION: "浮点错误",
  OUTPUT_LIMIT_EXCEEDED: "输出超限",
  INTERNAL_ERROR: "内部错误",
  RUNTIME_ERROR: "运行时错误"
};

/** 本地语言 → PTA 编译器代码（定义在 ./compilers.js，避免两处维护） */
const COMPILER_BY_LANGUAGE = compilers.DEFAULT_COMPILER_BY_LANGUAGE;

function submissionStatusText(status) {
  return SUBMISSION_STATUS_TEXT[status] || status || "未知";
}

function isAccepted(status) {
  return status === "ACCEPTED";
}

function compilerForLanguage(language) {
  return compilers.compilerForLanguage(language);
}

/** 题集信息：{ problemSet, exam, permission, status } */
async function getProblemSetExams(problemSetId, cookie) {
  return requestJson(`${ORIGIN}/api/problem-sets/${problemSetId}/exams`, { cookie });
}

/** 给题集建一个「考试」容器 —— 提交代码必须先有 examID */
async function createProblemSetExam(problemSetId, cookie) {
  return requestJson(`${ORIGIN}/api/problem-sets/${problemSetId}/exams`, { method: "POST", cookie });
}

/**
 * 取到可用来提交的 examID。没有就尝试创建一个。
 * 自己创建的题集（permission=47）PTA 不给建，直接说明原因。
 */
async function ensureExamId(problemSetId, cookie) {
  let info = await getProblemSetExams(problemSetId, cookie);
  if (info && info.exam && info.exam.id) {
    return { examId: info.exam.id, info };
  }
  const permission = info && info.permission ? info.permission.permission : undefined;
  if (permission === PROBLEM_PERMISSION.MY_PROBLEM_SET) {
    throw new PtaError(
      "这是你自己创建的题集，PTA 不为它创建考试容器，因此无法提交（导出题面和笔记不受影响）。",
      "no-exam"
    );
  }
  await createProblemSetExam(problemSetId, cookie);
  info = await getProblemSetExams(problemSetId, cookie);
  if (info && info.exam && info.exam.id) {
    return { examId: info.exam.id, info };
  }
  throw new PtaError("无法为这个题集创建考试容器，提交失败（题集可能尚未开始或已结束）。", "no-exam");
}

/** 组装提交报文（与 PTA 前端一致） */
function buildSubmissionDetail(options) {
  const opts = options || {};
  const detail = {
    problemId: "0",
    problemSetProblemId: String(opts.problemSetProblemId)
  };
  const key =
    opts.problemType === "CODE_COMPLETION" ? "codeCompletionSubmissionDetail" : "programmingSubmissionDetail";
  detail[key] = {
    compiler: opts.compiler,
    program: opts.program
  };
  if (opts.testInput !== undefined && opts.testInput !== null) {
    const content = opts.testInput.endsWith("\n") ? opts.testInput : `${opts.testInput}\n`;
    detail.customTestData = { hasCustomTestData: true, content };
  }
  return detail;
}

/** 提交代码 → { submissionId, error } */
async function submitSolution(examId, cookie, payload) {
  return requestJson(`${ORIGIN}/api/exams/${examId}/submissions`, {
    method: "POST",
    cookie,
    body: payload
  });
}

/** 取判题结果 */
async function getSubmissionResult(submissionId, cookie) {
  return requestJson(`${ORIGIN}/api/submissions/${submissionId}`, { cookie });
}

/** 取「自定义测试数据」的测试结果（不计入成绩） */
async function getTestResult(submissionId, cookie) {
  return requestJson(`${ORIGIN}/api/submissions/${submissionId}?custom_test_data_submission=true`, { cookie });
}

/* ------------------------------------------------------------------ */
/* 做题状态 / 签到                                                     */
/* ------------------------------------------------------------------ */

/** PTA 的 problemStatus 取值 → 中文（取自 PTA 前端的 ProblemSubmissionState） */
const PROBLEM_STATUS_TEXT = {
  PROBLEM_ACCEPTED: "答案正确",
  PROBLEM_WRONG_ANSWER: "答案错误",
  PROBLEM_NO_ANSWER: "未作答",
  NO_PROBLEM_STATUS: "无状态"
};

const PROBLEM_STATUS_SHORT = {
  PROBLEM_ACCEPTED: "AC",
  PROBLEM_WRONG_ANSWER: "WA",
  PROBLEM_NO_ANSWER: "-",
  NO_PROBLEM_STATUS: "-"
};

function problemStatusText(status) {
  if (!status) {
    return "-";
  }
  return PROBLEM_STATUS_TEXT[status] || status;
}

function problemStatusShort(status) {
  if (!status) {
    return "-";
  }
  return PROBLEM_STATUS_SHORT[status] || status;
}

function isAcceptedProblemStatus(status) {
  return status === "PROBLEM_ACCEPTED";
}

/** 整个题集里每道题的做题状态（一次请求拿全套，需要登录） */
async function getExamProblemStatus(problemSetId, cookie) {
  const json = await requestJson(`${ORIGIN}/api/problem-sets/${problemSetId}/exam-problem-status`, { cookie });
  return (json && json.problemStatus) || [];
}

/** 某题的最后一次提交（需要登录） */
async function getLastSubmission(problemSetId, problemId, cookie) {
  const json = await requestJson(
    `${ORIGIN}/api/problem-sets/${problemSetId}/last-submissions?&problem_set_problem_id=${encodeURIComponent(
      problemId
    )}`,
    { cookie }
  );
  return (json && json.submission) || null;
}

/** 今日签到状态：{ exists, rewardContent } */
async function getCheckInStatus(cookie) {
  return requestJson(`${ORIGIN}/api/users/rewards/DAILY_CHECK_IN`, { cookie });
}

/** 签到：{ rewards, error } */
async function checkIn(cookie) {
  return requestJson(`${ORIGIN}/api/users/checkin`, { method: "POST", cookie });
}

/* ------------------------------------------------------------------ */
/* 提交记录                                                            */
/* ------------------------------------------------------------------ */

/**
 * 题集的提交记录（游标分页，倒序）。已实测：
 *   返回 { submissions, hasBefore, problemSetProblemById, ... }；
 *   `before` 传上一页最后一条的 id，两页不重叠；
 *   `total` 恒为 0，不可信，别拿它算页数；
 *   ⚠️ `problem_set_problem_id` / `problemSetProblemId` 参数会被忽略，
 *      要按题筛选只能取回来自己过滤。
 * 单条字段：id / userId / problemType / problemSetProblemId / submitAt /
 *          status / score / compiler / time（秒！）/ memory（字节！）/ judgeAt
 */
async function getSubmissions(problemSetId, cookie, options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const query = [`limit=${limit}`];
  if (opts.before) {
    query.push(`before=${encodeURIComponent(opts.before)}`);
  }
  const json = await requestJson(
    `${ORIGIN}/api/problem-sets/${problemSetId}/submissions?${query.join("&")}`,
    { cookie }
  );
  return {
    submissions: (json && json.submissions) || [],
    hasBefore: Boolean(json && json.hasBefore),
    problemSetProblemById: (json && json.problemSetProblemById) || {}
  };
}

module.exports = {
  ORIGIN,
  PASSPORT_ORIGIN,
  PROBLEM_TYPE_INFO,
  PROBLEM_PERMISSION,
  SAMPLE_BEARING_TYPES,
  SUBMISSION_STATUS_TEXT,
  COMPILER_BY_LANGUAGE,
  PtaError,
  isAuthError,
  isAccepted,
  sleep,
  rawRequest,
  requestJson,
  getCurrentUser,
  getMyProblemSets,
  getAlwaysAvailableProblemSets,
  getProblemSetInfo,
  getProblemSummary,
  getProblemListPage,
  getAllProblems,
  getProblemDetail,
  getProblemSetExams,
  createProblemSetExam,
  ensureExamId,
  buildSubmissionDetail,
  submitSolution,
  getSubmissionResult,
  getTestResult,
  PROBLEM_STATUS_TEXT,
  problemStatusText,
  problemStatusShort,
  isAcceptedProblemStatus,
  getExamProblemStatus,
  getLastSubmission,
  getCheckInStatus,
  checkIn,
  getSubmissions,
  submissionStatusText,
  compilerForLanguage,
  parsePtaUrl,
  problemTypeId,
  problemTypeName,
  buildProblemUrl,
  buildProblemSetUrl,
  parseCookieInput
};
