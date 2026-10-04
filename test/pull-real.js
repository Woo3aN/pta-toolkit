"use strict";

/**
 * 真数据全链路测试：用公开题集的真实数据，走一遍「拉取 → 生成本地文件夹」。
 * 不需要登录，也不会碰你的工作区（默认写到系统临时目录）。
 *
 * 用法：node test/pull-real.js [题集ID] [题目数量] [输出目录]
 *   默认：题集 12（浙大版C语言程序设计题目集）、3 道、系统临时目录
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const api = require("../src/ptaApi");
const ws = require("../src/problemWorkspace");

const problemSetId = process.argv[2] || "12";
const count = Number(process.argv[3] || 3);
const root = process.argv[4] || fs.mkdtempSync(path.join(os.tmpdir(), "pta-pull-real-"));

function printTree(dir, prefix) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1;
    const full = path.join(dir, entry.name);
    const size = entry.isDirectory() ? "" : `  (${fs.statSync(full).size} B)`;
    console.log(`${prefix}${last ? "└── " : "├── "}${entry.name}${size}`);
    if (entry.isDirectory()) {
      printTree(full, `${prefix}${last ? "    " : "│   "}`);
    }
  });
}

async function main() {
  console.log(`题集 ${problemSetId}，工作区根目录：${root}\n`);

  const summaries = await api.getProblemSummary(problemSetId);
  console.log(`题型统计：${JSON.stringify(summaries)}`);

  const page = await api.getProblemListPage(problemSetId, "PROGRAMMING", 0, 50);
  const targets = page.problems.slice(0, count);
  console.log(`共 ${page.total} 道编程题，本次拉取 ${targets.length} 道\n`);

  let name = "";
  try {
    const info = await api.getProblemSetExams(problemSetId, "");
    name = (info && info.problemSet && info.problemSet.name) || "";
  } catch (_error) {
    name = "";
  }
  console.log(`题集名称：${name || "(未知)"}\n`);

  const indexEntries = [];
  for (const problem of targets) {
    const detail = await api.getProblemDetail(problemSetId, problem.id, "");
    const result = await ws.ensureProblemWorkspace({
      workspaceRoot: root,
      problemSetId,
      problemSetName: name,
      problem: detail,
      language: "C++",
      fileNameFormat: "{label}-{title}",
      url: api.buildProblemUrl(problemSetId, problem.id, detail.type),
      problemTypeName: api.problemTypeName(detail.type)
    });
    indexEntries.push({
      label: problem.label,
      title: problem.title,
      type: problem.type,
      problemTypeName: api.problemTypeName(problem.type),
      score: problem.score,
      dirName: result.problemDirName
    });
    console.log(
      `${problem.label} ${problem.title} -> ${result.problemDirName}\n` +
        `    例题面 ${fs.statSync(result.statementPath).size} B，样例 ${result.samples.length} 组，` +
        `时限 ${result.metadata.timeLimit}ms / 内存 ${result.metadata.memoryLimit}KB，` +
        `源码 ${result.createdSource ? "新建" : "已存在"}`
    );
  }

  await ws.writeProblemSetIndex(ws.buildProblemSetDirectory(root, problemSetId, name), {
    problemSetId,
    problemSetName: name || problemSetId,
    url: api.buildProblemSetUrl(problemSetId),
    problems: indexEntries
  });

  console.log("\n生成的目录结构：");
  printTree(root, "");

  const firstDir = path.join(ws.buildProblemSetDirectory(root, problemSetId, name), targets[0] && ws.buildProblemDirName(targets[0]));
  const statementPath = path.join(firstDir, ws.STATEMENT_FILE_NAME);
  if (fs.existsSync(statementPath)) {
    const text = fs.readFileSync(statementPath, "utf8");
    console.log("\n===== problem.md 前 1200 字 =====");
    console.log(text.slice(0, 1200));
    console.log("...\n");

    const notesPath = path.join(firstDir, ws.NOTES_FILE_NAME);
    if (fs.existsSync(notesPath)) {
      console.log("===== notes.md 前 700 字 =====");
      console.log(fs.readFileSync(notesPath, "utf8").slice(0, 700));
    }

    const sourcePath = path.join(firstDir, "main.cpp");
    if (fs.existsSync(sourcePath)) {
      console.log("\n===== main.cpp =====");
      console.log(fs.readFileSync(sourcePath, "utf8"));
    }
  }

  console.log(`\n完成。完整内容在：${root}`);
}

main().catch((error) => {
  console.error(`\n失败：${error.kind || "unknown"} ${error.message}`);
  process.exitCode = 1;
});
