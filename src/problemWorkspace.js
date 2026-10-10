"use strict";

/**
 * 本地工作区生成。目录与文件命名刻意对齐 xmuoj 插件的约定，
 * 这样两个 OJ 的工作区结构一致，批量测试 / Git 同步的思路可以复用。
 *
 *   {workspaceRoot}/
 *     problem-sets/
 *       {题集id}-{题集名}/
 *         index.md                  题集索引（marker 之外的内容不会被刷新覆盖）
 *         {题号}-{标题}/
 *           problem.md              题面 + 样例（每次刷新都重写，别手改）
 *           .pta.json               元数据（problemId / 语言 / 源文件名 / 时限…）
 *           main.cpp                源码（只在缺失时创建，永不覆盖）
 *           notes.md                笔记（只在缺失时创建，永不覆盖）
 *           samples/1.in  1.out     样例输入输出
 *
 * 本模块不依赖 vscode，配置项全部由调用方以参数传入，方便脱离编辑器单测。
 */

const fs = require("fs");
const path = require("path");
const templates = require("./templates");
const notes = require("./notes");
const problemInfo = require("./problemInfo");

const METADATA_FILE_NAME = ".pta.json";
const PROBLEM_SET_DIR_NAME = "problem-sets";
const INDEX_FILE_NAME = "index.md";
const NOTES_FILE_NAME = "notes.md";
const STATEMENT_FILE_NAME = "problem.md";
const SAMPLES_DIR_NAME = "samples";

const INDEX_BEGIN = "<!-- pta:index:begin -->";
const INDEX_END = "<!-- pta:index:end -->";

const ACTIVITY_LOG_FILE = ".pta-activity.json";

/* ------------------------------------------------------------------ */
/* 名称处理                                                            */
/* ------------------------------------------------------------------ */

/**
 * Windows 保留设备名。用这些名字建目录 / 文件会直接失败（哪怕带扩展名，
 * 如 CON.txt 也是保留的）。PTA 题目标题本身少见，但如果把
 * `pta.fileNameFormat` 改成纯 `{title}` 就有可能撞上，因此兜一道。
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** 生成 Windows 下安全的目录 / 文件名，保留中文，去掉非法字符。 */
function sanitizeName(text, maxLength) {
  const max = maxLength || 60;
  let name = String(text === null || text === undefined ? "" : text)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!name) {
    name = "problem";
  }
  if (name.length > max) {
    name = name.slice(0, max).replace(/[.\s]+$/, "");
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    name = `${name}_`;
  }
  return name;
}

/** 按 {label} / {title} / {pid} 模板生成题目文件夹名。 */
function buildProblemDirName(problem, fileNameFormat) {
  const format = fileNameFormat && String(fileNameFormat).trim() ? String(fileNameFormat) : "{label}-{title}";
  const filled = format
    .replace(/\{label\}/g, (problem && problem.label) || "")
    .replace(/\{title\}/g, (problem && problem.title) || "")
    .replace(/\{pid\}/g, (problem && (problem.problemId || problem.id)) || "");
  let name = sanitizeName(filled, 70);
  if (!name || name === "problem") {
    name = sanitizeName((problem && (problem.problemId || problem.id)) || "problem", 40);
  }
  return name;
}

function buildProblemSetDirectory(root, problemSetId, problemSetName) {
  const label = problemSetName
    ? `${problemSetId}-${sanitizeName(problemSetName, 50)}`
    : String(problemSetId);
  return path.join(root, PROBLEM_SET_DIR_NAME, label);
}

function buildProblemDirectory(root, problemSetId, problemSetName, problem, fileNameFormat) {
  return path.join(
    buildProblemSetDirectory(root, problemSetId, problemSetName),
    buildProblemDirName(problem, fileNameFormat)
  );
}

function timestampForFile(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function dateOnly(date) {
  return timestampForFile(date).slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* 题面文本处理                                                        */
/* ------------------------------------------------------------------ */

const ENTITY_MAP = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&amp;": "&"
};

/** 少数题目的题面是 HTML 片段（含公式 / 插图），做一次轻量转换兜底。 */
function htmlToMarkdown(html) {
  let text = String(html || "");
  const images = [];
  text = text.replace(/<img[^>]*?src=["']([^"']+)["'][^>]*>/gi, (_match, src) => {
    const url = src.startsWith("//") ? `https:${src}` : src;
    images.push(url);
    return `\n\n![](${url})\n\n`;
  });
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner) => {
    return `\n\n\`\`\`text\n${inner}\n\`\`\`\n\n`;
  });
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|tr|li)>/gi, "\n\n");
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<h[1-6][^>]*>/gi, "\n\n### ");
  text = text.replace(/<\/?(?:strong|b)[^>]*>/gi, "**");
  text = text.replace(/<\/?(?:em|i)[^>]*>/gi, "*");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&[a-z#0-9]+;/gi, (match) => {
    const key = match.toLowerCase();
    if (ENTITY_MAP[key]) {
      return ENTITY_MAP[key];
    }
    const numeric = match.match(/&#(\d+);/);
    if (numeric) {
      return String.fromCharCode(Number(numeric[1]));
    }
    return match;
  });
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function normalizeStatement(raw) {
  const text = String(raw === null || raw === undefined ? "" : raw);
  if (!text.trim()) {
    return "";
  }
  const looksLikeHtml = /<(p|div|br|pre|img|ul|ol|li|h[1-6]|table|span|strong|em)\b/i.test(text);
  return looksLikeHtml ? htmlToMarkdown(text) : text.trim();
}

/* ------------------------------------------------------------------ */
/* 样例处理                                                            */
/* ------------------------------------------------------------------ */

const SAMPLE_CONFIG_KEYS = [
  "programmingProblemConfig",
  "codeCompletionProblemConfig",
  "multipleFileProblemConfig"
];

function extractSamples(problem) {
  const config = problem && problem.problemConfig ? problem.problemConfig : {};
  let raw = [];
  let problemConfig = null;
  for (const key of SAMPLE_CONFIG_KEYS) {
    const candidate = config[key];
    if (candidate && Array.isArray(candidate.exampleTestDatas) && candidate.exampleTestDatas.length) {
      raw = candidate.exampleTestDatas;
      problemConfig = candidate;
      break;
    }
    if (!problemConfig && candidate) {
      problemConfig = candidate;
    }
  }

  const samples = [];
  const seen = new Set();
  let duplicates = 0;
  for (const item of raw) {
    const input = String((item && item.input) || "");
    const output = String((item && item.output) || "");
    const key = `${input}\u0000${output}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    samples.push({ name: (item && item.name) || "", input, output });
  }
  return { samples, problemConfig: problemConfig || {}, duplicates, rawCount: raw.length };
}

/* ------------------------------------------------------------------ */
/* Markdown 生成                                                       */
/* ------------------------------------------------------------------ */

function codeBlock(text) {
  const body = String(text === null || text === undefined ? "" : text);
  const fence = body.includes("```") ? "````" : "```";
  return `${fence}text\n${body.replace(/\s+$/, "")}\n${fence}`;
}

function buildProblemMarkdown(problem, context) {
  const ctx = context || {};
  const samples = ctx.samples || [];
  const config = ctx.problemConfig || {};
  const lines = [];

  // 同一批元信息在「预览面板」里也要显示，统一由 problemInfo 出文案，
  // 保证创建代码之前 / 之后看到的是同一套东西。
  const info = {
    timeLimit: config.timeLimit,
    memoryLimit: config.memoryLimit,
    problemSetName: ctx.problemSetName,
    problemSetId: ctx.problemSetId,
    problemTypeName: ctx.problemTypeName || problem.type || "未知",
    score: problem.score,
    difficulty: problem.difficulty,
    author: problem.author,
    url: ctx.url,
    fetchedAt: timestampForFile()
  };

  lines.push(`# ${problem.label ? problem.label + " " : ""}${problem.title || ""}`.trim());
  lines.push("");
  // 顶部只留「读题真正要用」的两条：时限与内存。
  // 题集 / 题型 / 分值 / 作者 / 在线地址 / 抓取时间都收在文件末尾的「详细信息」，
  // 免得每打开一道题先翻一屏元信息才看到正文。
  const limitsText = problemInfo.limitsText(info);
  if (limitsText) {
    lines.push(`> ${limitsText}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  const statement = normalizeStatement(problem.description) || normalizeStatement(problem.content);
  lines.push("## 题目描述");
  lines.push("");
  lines.push(statement || "_PTA 没有返回题面正文。_");
  lines.push("");

  if (samples.length) {
    lines.push("## 样例");
    lines.push("");
    samples.forEach((sample, index) => {
      lines.push(`### 样例 ${index + 1}`);
      lines.push("");
      lines.push("#### 输入");
      lines.push("");
      lines.push(codeBlock(sample.input));
      lines.push("");
      lines.push("#### 输出");
      lines.push("");
      lines.push(codeBlock(sample.output));
      lines.push("");
    });
    lines.push(
      `> 样例已同时写入 \`${SAMPLES_DIR_NAME}/\` 目录（\`1.in\` / \`1.out\` …），方便本地直接跑。`
    );
    lines.push("");
  } else {
    lines.push("## 样例");
    lines.push("");
    lines.push("_PTA 没有返回结构化样例，请以上方题面中的样例为准。_");
    lines.push("");
  }

  if (ctx.duplicates) {
    lines.push(
      `> 注：PTA 返回了 ${ctx.rawCount} 条样例，其中 ${ctx.duplicates} 条完全重复，已去重。`
    );
    lines.push("");
  }

  // 详细信息：不挡着读题，统一收在文件最后
  const details = problemInfo.detailItems(info);
  if (details.length) {
    lines.push("## 详细信息");
    lines.push("");
    details.forEach((item) => lines.push(`- ${item.label}：${item.value}`));
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("<!-- 本文件由 PTA Toolkit 生成，每次刷新题面都会重写。笔记请写在 notes.md。 -->");
  lines.push("");

  return lines.join("\n");
}

function yamlString(value) {
  const text = String(value === null || value === undefined ? "" : value);
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildNotesSkeleton(problem, context) {
  const ctx = context || {};
  const config = ctx.problemConfig || {};
  const lines = [];
  lines.push("---");
  lines.push(`title: ${yamlString(`${problem.label || ""} ${problem.title || ""}`.trim())}`);
  if (ctx.problemSetName) {
    lines.push(`problemSet: ${yamlString(ctx.problemSetName)}`);
  }
  lines.push(`problemSetId: ${yamlString(ctx.problemSetId)}`);
  lines.push(`problemId: ${yamlString(problem.id || problem.problemId || "")}`);
  lines.push(`problemType: ${problem.type || "PROGRAMMING"}`);
  if (problem.difficulty !== undefined && problem.difficulty !== null) {
    lines.push(`difficulty: ${problem.difficulty}`);
  }
  if (config.timeLimit) {
    lines.push(`timeLimit: ${config.timeLimit}`);
  }
  if (config.memoryLimit) {
    lines.push(`memoryLimit: ${config.memoryLimit}`);
  }
  if (ctx.url) {
    lines.push(`url: ${yamlString(ctx.url)}`);
  }
  lines.push("status: todo");
  lines.push(`created: ${dateOnly()}`);
  lines.push("tags:");
  lines.push("  - PTA");
  lines.push("  - 算法题");
  lines.push("---");
  lines.push("");
  lines.push(`# ${problem.label ? problem.label + " " : ""}${problem.title || ""}`.trim());
  lines.push("");
  lines.push("**题意**：（用自己的话一句话说清要做什么）");
  lines.push("");
  lines.push("## 思路");
  lines.push("");
  lines.push("");
  lines.push("## 边界与易错点");
  lines.push("");
  lines.push("");
  lines.push("## 复杂度");
  lines.push("");
  lines.push("- 时间：");
  lines.push("- 空间：");
  lines.push("");
  lines.push("## 代码");
  lines.push("");
  lines.push(`（本题源码：\`${ctx.sourceFile || templates.sourceFileName(ctx.language || "C++")}\`）`);
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 题集索引                                                            */
/* ------------------------------------------------------------------ */

function buildIndexTable(problems) {
  const lines = [];
  lines.push("| # | 题号 | 标题 | 类型 | 分值 | 状态 | 本地目录 |");
  lines.push("|---|---|---|---|---|---|---|");
  problems.forEach((item, index) => {
    const dir = item.dirName;
    const link = dir ? `[打开](<${dir}/${STATEMENT_FILE_NAME}>)` : "-";
    lines.push(
      `| ${index + 1} | ${item.label || "-"} | ${String(item.title || "").replace(/\|/g, "\\|")} | ${
        item.problemTypeName || item.type || "-"
      } | ${item.score === undefined || item.score === null ? "-" : item.score} | ${
        item.statusShort || "-"
      } | ${link} |`
    );
  });
  return lines.join("\n");
}

/** 题号排序：让「练习2-2」排在「练习2-10」前面 */
function compareLabels(a, b) {
  return String(a || "").localeCompare(String(b || ""), "zh-CN", { numeric: true, sensitivity: "base" });
}

/**
 * 读取一个题集目录下所有题目的本地元数据。
 * 索引就是这样从磁盘内容生成的 —— 索引永远和本地实际文件一致。
 */
async function readProblemSetEntries(problemSetDir) {
  let names = [];
  try {
    names = await fs.promises.readdir(problemSetDir);
  } catch (_error) {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const dir = path.join(problemSetDir, name);
    let stat;
    try {
      stat = await fs.promises.stat(dir);
    } catch (_error) {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const metadata = await readMetadata(dir);
    if (!metadata || !metadata.problemId) {
      continue;
    }
    entries.push({ dirName: name, problemDir: dir, metadata });
  }
  entries.sort((a, b) => compareLabels(a.metadata.label, b.metadata.label));
  return entries;
}

/** 把本地元数据整理成索引表格需要的一行 */
function toIndexEntry(entry) {
  const metadata = entry.metadata || {};
  return {
    label: metadata.label,
    title: metadata.title,
    type: metadata.problemType,
    problemTypeName: metadata.problemTypeName,
    score: metadata.score,
    statusShort: metadata.statusShort || api_problemStatusShort(metadata.problemStatus),
    dirName: entry.dirName
  };
}

/** 与 ptaApi.problemStatusShort 同义，内置一份避免循环依赖 */
function api_problemStatusShort(status) {
  if (!status) {
    return "-";
  }
  if (status === "PROBLEM_ACCEPTED") {
    return "AC";
  }
  if (status === "PROBLEM_WRONG_ANSWER") {
    return "WA";
  }
  if (status === "PROBLEM_NO_ANSWER") {
    return "-";
  }
  return status;
}

function buildProblemSetIndex(context) {
  const ctx = context || {};
  const problems = ctx.problems || [];
  const counts = {};
  problems.forEach((item) => {
    const key = item.problemTypeName || item.type || "未知";
    counts[key] = (counts[key] || 0) + 1;
  });
  const countText = Object.keys(counts)
    .map((key) => `${key} ${counts[key]} 道`)
    .join("，");

  const lines = [];
  lines.push(`# ${ctx.problemSetName || "题集"}`);
  lines.push("");
  lines.push(`- 题集 ID：\`${ctx.problemSetId}\``);
  if (ctx.url) {
    lines.push(`- 在线地址：${ctx.url}`);
  }
  lines.push(`- 已抓取：${problems.length} 道${countText ? `（${countText}）` : ""}`);
  lines.push(`- 本地更新：${timestampForFile()}`);
  lines.push("");
  lines.push(INDEX_BEGIN);
  lines.push("");
  lines.push(buildIndexTable(problems));
  lines.push("");
  lines.push(INDEX_END);
  lines.push("");
  lines.push(REMARKS_HEADING);
  lines.push("");
  return lines.join("\n");
}

const REMARKS_HEADING = "## 我的备注";

/** marker 之间的内容每次刷新都重写；marker 之后用户自己写的备注原样保留。 */
async function writeProblemSetIndex(problemSetDir, context) {
  const indexPath = path.join(problemSetDir, INDEX_FILE_NAME);
  let existing = "";
  try {
    existing = await fs.promises.readFile(indexPath, "utf8");
  } catch (_error) {
    existing = "";
  }

  const generated = buildProblemSetIndex(context);
  let content = generated;

  if (existing.trim()) {
    const begin = existing.indexOf(INDEX_BEGIN);
    const end = existing.indexOf(INDEX_END);
    let tail = "";
    if (begin >= 0 && end > begin) {
      tail = existing.slice(end + INDEX_END.length);
    } else {
      // 旧文件没有 marker（可能是手工建的），整个当作备注留下来
      tail = existing;
    }
    tail = tail.replace(/^\s*\n/, "");
    if (tail.startsWith(REMARKS_HEADING)) {
      tail = tail.slice(REMARKS_HEADING.length);
    }
    tail = tail.replace(/^\s*\n/, "");
    content = `${generated}${tail}`;
  }

  await fs.promises.mkdir(problemSetDir, { recursive: true });
  await fs.promises.writeFile(indexPath, content, "utf8");
  return indexPath;
}

/* ------------------------------------------------------------------ */
/* 元数据                                                              */
/* ------------------------------------------------------------------ */

async function readMetadata(problemDir) {
  try {
    const text = await fs.promises.readFile(path.join(problemDir, METADATA_FILE_NAME), "utf8");
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

async function writeMetadata(problemDir, metadata) {
  const target = path.join(problemDir, METADATA_FILE_NAME);
  await fs.promises.writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return target;
}

/** 从某个文件往上找 .pta.json，用来定位「当前题目」。 */
async function findMetadataUpward(startPath) {
  let currentDir;
  try {
    const stat = await fs.promises.stat(startPath);
    currentDir = stat.isDirectory() ? startPath : path.dirname(startPath);
  } catch (_error) {
    currentDir = path.dirname(startPath);
  }
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(currentDir, METADATA_FILE_NAME);
    try {
      const metadata = JSON.parse(await fs.promises.readFile(candidate, "utf8"));
      return { metadata, metadataPath: candidate, problemDir: currentDir };
    } catch (error) {
      if (error && error.code && error.code !== "ENOENT") {
        return null;
      }
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return null;
    }
    currentDir = parent;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 生成工作区                                                          */
/* ------------------------------------------------------------------ */

async function fileExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 生成（或刷新）一道题的本地工作区。
 *
 * 刷新规则：
 *   problem.md / samples/  → 每次重写
 *   源码文件 / notes.md     → 只在缺失时创建，永不覆盖
 */
async function ensureProblemWorkspace(options) {
  const opts = options || {};
  const root = opts.workspaceRoot;
  const problem = opts.problem || {};
  const problemSetId = String(opts.problemSetId || "");
  const problemSetName = opts.problemSetName || "";
  const language = templates.normalizeLanguage(opts.language);
  const fileNameFormat = opts.fileNameFormat;
  const problemId = String(problem.id || problem.problemId || "");

  let problemDir = opts.problemDir || buildProblemDirectory(root, problemSetId, problemSetName, problem, fileNameFormat);
  let existingMetadata = await readMetadata(problemDir);
  if (!opts.problemDir && existingMetadata && String(existingMetadata.problemId) !== problemId && problemId) {
    // 题号相同但其实是另一道题（同名碰撞），补上题目 ID 保证唯一
    problemDir = `${problemDir}-${problemId}`;
    existingMetadata = await readMetadata(problemDir);
  }

  const samplesDir = path.join(problemDir, SAMPLES_DIR_NAME);
  await fs.promises.mkdir(samplesDir, { recursive: true });

  const sourceFile = opts.sourceFile || templates.sourceFileName(language);
  const sourcePath = path.join(problemDir, sourceFile);
  const statementPath = path.join(problemDir, STATEMENT_FILE_NAME);
  const notesPath = path.join(problemDir, NOTES_FILE_NAME);
  const url = opts.url || "";

  const extracted = extractSamples(problem);
  const context = {
    problemSetId,
    problemSetName,
    problemTypeName: opts.problemTypeName,
    url,
    samples: extracted.samples,
    problemConfig: extracted.problemConfig,
    duplicates: extracted.duplicates,
    rawCount: extracted.rawCount,
    language,
    sourceFile
  };

  await fs.promises.writeFile(statementPath, buildProblemMarkdown(problem, context), "utf8");

  const sampleFiles = [];
  for (let index = 0; index < extracted.samples.length; index += 1) {
    const sample = extracted.samples[index];
    const inputPath = path.join(samplesDir, `${index + 1}.in`);
    const outputPath = path.join(samplesDir, `${index + 1}.out`);
    await fs.promises.writeFile(inputPath, sample.input, "utf8");
    await fs.promises.writeFile(outputPath, sample.output, "utf8");
    sampleFiles.push({ inputPath, outputPath });
  }

  const createdSource = !(await fileExists(sourcePath));
  if (createdSource && opts.autoCreateSource !== false) {
    const template = templates.sourceFileContent(language, opts.templateDir);
    // 用内置模板时补一个空的 @pintia note 块；用你自己的模板文件时不插手
    const content =
      opts.includeNoteBlock === false || template.from
        ? template.content
        : notes.ensureNoteBlock(language, template.content);
    await fs.promises.writeFile(sourcePath, content, "utf8");
  }

  const createdNotes = !(await fileExists(notesPath));
  if (createdNotes && opts.createNotesFile !== false) {
    await fs.promises.writeFile(notesPath, buildNotesSkeleton(problem, Object.assign({}, context, { sourceFile })), "utf8");
  }

  const now = new Date().toISOString();
  const sourceFiles = Object.assign({}, (existingMetadata && existingMetadata.sourceFiles) || {});
  if (sourceFiles[language] === undefined && (await fileExists(sourcePath))) {
    sourceFiles[language] = sourceFile;
  }

  const metadata = Object.assign({}, existingMetadata || {}, {
    version: 1,
    problemSetId,
    problemSetName: problemSetName || (existingMetadata && existingMetadata.problemSetName) || "",
    problemId,
    label: problem.label || "",
    title: problem.title || "",
    problemType: problem.type || "PROGRAMMING",
    problemTypeName: opts.problemTypeName || "",
    language,
    sourceFile,
    sourceFiles,
    score: problem.score === undefined ? null : problem.score,
    difficulty: problem.difficulty === undefined ? null : problem.difficulty,
    author: problem.author || "",
    compiler: problem.compiler || "",
    timeLimit: extracted.problemConfig.timeLimit || null,
    memoryLimit: extracted.problemConfig.memoryLimit || null,
    url,
    sampleCount: extracted.samples.length,
    createdAt: (existingMetadata && existingMetadata.createdAt) || now,
    updatedAt: now
  });

  const metadataPath = await writeMetadata(problemDir, metadata);

  return {
    problemDir,
    problemDirName: path.basename(problemDir),
    statementPath,
    notesPath,
    sourcePath,
    metadataPath,
    metadata,
    samples: sampleFiles,
    samplesDropped: extracted.duplicates,
    createdSource: createdSource && opts.autoCreateSource !== false,
    createdNotes: createdNotes && opts.createNotesFile !== false,
    config: extracted.problemConfig
  };
}

/** 切换语言：新建该语言的源码文件（已存在则直接返回），并更新元数据。 */
async function applyLanguage(problemDir, metadata, language, templateDir, includeNoteBlock) {
  const lang = templates.normalizeLanguage(language);
  const existingSource = (metadata && metadata.sourceFiles && metadata.sourceFiles[lang]) || templates.sourceFileName(lang);
  const sourcePath = path.join(problemDir, existingSource);
  let created = false;
  if (!(await fileExists(sourcePath))) {
    const template = templates.sourceFileContent(lang, templateDir);
    const content =
      includeNoteBlock === false || template.from ? template.content : notes.ensureNoteBlock(lang, template.content);
    await fs.promises.writeFile(sourcePath, content, "utf8");
    created = true;
  }
  const sourceFiles = Object.assign({}, (metadata && metadata.sourceFiles) || {}, { [lang]: existingSource });
  const nextMetadata = Object.assign({}, metadata || {}, {
    language: lang,
    sourceFile: existingSource,
    sourceFiles,
    updatedAt: new Date().toISOString()
  });
  await writeMetadata(problemDir, nextMetadata);
  return { metadata: nextMetadata, sourcePath, created };
}

module.exports = {
  METADATA_FILE_NAME,
  PROBLEM_SET_DIR_NAME,
  INDEX_FILE_NAME,
  NOTES_FILE_NAME,
  STATEMENT_FILE_NAME,
  SAMPLES_DIR_NAME,
  INDEX_BEGIN,
  INDEX_END,
  sanitizeName,
  buildProblemDirName,
  buildProblemDirectory,
  buildProblemSetDirectory,
  timestampForFile,
  dateOnly,
  htmlToMarkdown,
  normalizeStatement,
  extractSamples,
  buildProblemMarkdown,
  buildNotesSkeleton,
  buildProblemSetIndex,
  writeProblemSetIndex,
  compareLabels,
  readProblemSetEntries,
  toIndexEntry,
  readMetadata,
  writeMetadata,
  findMetadataUpward,
  ensureProblemWorkspace,
  applyLanguage,
  fileExists
};
