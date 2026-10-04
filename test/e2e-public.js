"use strict";

/**
 * 实网端到端测试：用公开题集验证「题面 + 样例」这条链路真的能拉到。
 * 用法：node test/e2e-public.js [题集ID]   默认 12（浙大版C语言程序设计题目集）
 */

const api = require("../src/ptaApi");

const problemSetId = process.argv[2] || "12";

function line(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  line(`题集 ${problemSetId} 的题型统计`);
  const summaries = await api.getProblemSummary(problemSetId);
  console.log(JSON.stringify(summaries));

  const types = Object.keys(summaries).filter((type) => api.SAMPLE_BEARING_TYPES.indexOf(type) >= 0);
  if (!types.length) {
    throw new Error("这个题集没有编程题");
  }

  for (const type of types) {
    line(`${type} 题目列表（第 1 页）`);
    const page = await api.getProblemListPage(problemSetId, type, 0, 3);
    console.log(`total = ${page.total}`);
    page.problems.slice(0, 3).forEach((problem) => {
      console.log(
        `  ${problem.label} | ${problem.title} | id=${problem.id} | type=${problem.type} | compiler=${problem.compiler}`
      );
    });

    const target = page.problems[0];
    if (!target) {
      continue;
    }

    line(`题面 + 样例：${target.label} ${target.title}`);
    const detail = await api.getProblemDetail(problemSetId, target.id);
    const config =
      (detail.problemConfig && (detail.problemConfig.programmingProblemConfig || detail.problemConfig.codeCompletionProblemConfig)) ||
      {};
    const raw = config.exampleTestDatas || [];
    const extracted = require("../src/problemWorkspace").extractSamples(detail);

    console.log(`title        = ${detail.title}`);
    console.log(`label        = ${detail.label}`);
    console.log(`type         = ${detail.type}`);
    console.log(`timeLimit    = ${config.timeLimit} ms`);
    console.log(`memoryLimit  = ${config.memoryLimit} KB`);
    console.log(`description  = ${JSON.stringify(String(detail.description || "").slice(0, 160))}`);
    console.log(`含 HTML 标签 = ${/<(p|div|br|pre|img|ul|li)\b/i.test(String(detail.description || ""))}`);
    console.log(`原始样例条数 = ${raw.length}，去重后 = ${extracted.samples.length}（重复 ${extracted.duplicates}）`);
    extracted.samples.forEach((sample, index) => {
      console.log(`  样例 ${index + 1} 输入 = ${JSON.stringify(sample.input)}`);
      console.log(`  样例 ${index + 1} 输出 = ${JSON.stringify(sample.output)}`);
    });
    console.log(`在线链接     = ${api.buildProblemUrl(problemSetId, target.id, detail.type)}`);
  }

  line("提交记录接口（公开题集无需登录即可读）");
  const submissions = await api.getSubmissions(problemSetId, "", { limit: 3 });
  console.log(`返回 ${submissions.submissions.length} 条，hasBefore = ${submissions.hasBefore}`);
  if (submissions.submissions.length) {
    const first = submissions.submissions[0];
    console.log(
      `首条：status=${first.status} score=${first.score} ` +
        `time=${first.time}(秒) memory=${first.memory}(字节) compiler=${first.compiler}`
    );
    console.log(`       problemSetProblemId=${first.problemSetProblemId} submitAt=${first.submitAt}`);
    console.log(`带出的题目信息条数：${Object.keys(submissions.problemSetProblemById || {}).length}`);
  }

  line("URL 解析");
  [
    `https://pintia.cn/problem-sets/${problemSetId}/exam/problems/type/7?problemSetProblemId=237`,
    `https://pintia.cn/problem-sets/${problemSetId}/problems/237`,
    `https://pintia.cn/problem-sets/${problemSetId}`,
    problemSetId
  ].forEach((url) => {
    console.log(`${url}\n  -> ${JSON.stringify(api.parsePtaUrl(url))}`);
  });

  line("Cookie 输入解析");
  ["abc123", "PTASession=abc123", "PTASession=abc123; JSESSIONID=xyz"].forEach((input) => {
    console.log(`${input}  ->  ${api.parseCookieInput(input)}`);
  });

  line("判题状态中文");
  ["ACCEPTED", "WRONG_ANSWER", "TIME_LIMIT_EXCEEDED", "COMPILE_ERROR", "SEGMENTATION_FAULT"].forEach(
    (status) => console.log(`${status} -> ${api.submissionStatusText(status)}`)
  );

  console.log("\n全部通过。");
}

main().catch((error) => {
  console.error(`\n失败：${error.kind || "unknown"} ${error.message}`);
  process.exitCode = 1;
});
