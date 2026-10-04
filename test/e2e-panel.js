"use strict";

/**
 * 实网测试：题目预览面板用真实题面渲染。
 * 不覆盖离线逻辑（那些在 offline.js），只验证「PTA 的真实题面能被正确渲染成面板」。
 *
 * 用法：node test/e2e-panel.js [题集ID] [取几道题，默认 3]
 * 无需登录（公开题集可匿名拉取）；需要验证自己的题集时用 PTA_COOKIE 环境变量。
 */

const api = require("../src/ptaApi");
const panel = require("../src/problemPanel");
const markdown = require("../src/markdown");

let failed = 0;

function check(label, condition, extra) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra === undefined ? "" : ` -> ${JSON.stringify(extra)}`}`);
  }
}

(async () => {
  const problemSetId = process.argv[2] || "12";
  const wanted = Number(process.argv[3] || 3);
  const cookie = process.env.PTA_COOKIE || "";

  console.log(`题集 ${problemSetId}：拉取题目列表`);
  const list = await api.getProblemListPage(problemSetId, "PROGRAMMING", 0, Math.max(wanted, 6), cookie);
  const problems = (list.problems || []).slice(0, wanted);
  if (!problems.length) {
    throw new Error("没有取到题目，题集 ID 可能不对。");
  }

  for (const item of problems) {
    const detail = await api.getProblemDetail(problemSetId, item.id, cookie);
    const statement = detail.description || detail.content || "";
    const limits = (detail.problemConfig && detail.problemConfig.programmingProblemConfig) || {};

    console.log(`\n${detail.label}  ${detail.title}`);

    check("题面非空", statement.length > 0, statement.length);
    check("题面是 Markdown（不是整段 HTML）", statement.indexOf("<div") < 0, statement.slice(0, 80));

    const rendered = markdown.renderMarkdown(panel.stripLeadingHeading(statement));
    check("渲染后没有残留占位符", rendered.indexOf("\u0000") < 0);
    check("渲染后没有脚本注入", !/<script/i.test(rendered) && !/onerror=/i.test(rendered));
    check("渲染出了正文", rendered.replace(/<[^>]+>/g, "").trim().length > 10);

    const html = panel.buildPanelHtml({
      problem: { label: detail.label, title: detail.title, problemSetId, problemId: item.id },
      statement,
      meta: {
        problemTypeName: api.problemTypeName(detail.type),
        score: detail.score,
        difficulty: detail.difficulty,
        timeLimit: limits.timeLimit,
        memoryLimit: limits.memoryLimit
      },
      workspace: { hasWorkspace: false, language: "C++", sourceFile: "main.cpp", hasNotes: false },
      root: ""
    });

    check("面板 HTML 完整", html.startsWith("<!DOCTYPE html>") && html.includes("</html>"));
    check("有主按钮（创建代码）", html.includes(">创建代码<"));
    check("带 MathJax 许可", html.includes("cdn.jsdelivr.net/npm/mathjax"));
    check("标题渲染进面板", html.includes(detail.title.slice(0, 8)));

    await api.sleep(600);
  }

  console.log(`\n${failed === 0 ? "全部通过。" : `${failed} 项失败。`}`);
  if (failed) {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("失败：", error.message);
  process.exitCode = 1;
});
