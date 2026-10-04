"use strict";

/**
 * 与 pintia 插件兼容的 @pintia 注释块，以及笔记与源码之间的同步。
 *
 * 源码里可以写三种块（用任意注释风格都行，解析只认 @pintia 标记本身）：
 *
 *   // @pintia code=start        ← 只提交这一段（不写则整文件提交）
 *   // @pintia code=end
 *   // @pintia test=start        ← 自定义测试输入
 *   // @pintia test=end
 *   // @pintia note=start        ← 笔记；和 pintia 一样会随代码一起提交
 *   // @pintia note=end
 */

const fs = require("fs");
const path = require("path");

const ANNOTATION = /@pintia\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(start|end)/;

const NOTE_SYNC_BEGIN = "<!-- pta:code-note:begin -->";
const NOTE_SYNC_END = "<!-- pta:code-note:end -->";
const NOTE_SECTION_TITLE = "## 代码里的笔记（@pintia note）";

function commentStyle(language) {
  if (language === "Python") {
    return { open: "# ", close: "# ", line: "# " };
  }
  return { block: true };
}

/**
 * 解析源码里的 @pintia 块。
 * 返回 { code, tests, notes, blocks }；code / notes 取最后一个同名块。
 */
function extractBlocks(text) {
  const lines = String(text === null || text === undefined ? "" : text).split(/\r?\n/);
  const result = { code: "", tests: [], notes: "", blocks: [] };
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(ANNOTATION);
    if (match) {
      const key = match[1].toLowerCase();
      const kind = match[2].toLowerCase();
      if (kind === "start") {
        current = { key, startLine: index, lines: [] };
      } else if (current && current.key === key) {
        current.endLine = index;
        result.blocks.push(current);
        current = null;
      }
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  for (const block of result.blocks) {
    const lines = trimBlankEdges(block.lines);
    if (block.key === "code") {
      // 代码块原样保留，绝不能动
      result.code = lines.join("\n");
    } else if (block.key === "test") {
      result.tests.push(stripCommentDecoration(lines).join("\n"));
    } else if (block.key === "note") {
      result.notes = stripCommentDecoration(lines).join("\n").trim();
    }
  }
  return result;
}

/**
 * 剥掉块内每行开头的注释装饰（`* `、`// `、`# `）以及收尾的 `*​/`，
 * 这样把笔记同步进 notes.md 时不会带上 `* ` 前缀。
 * 只在 note / test 这类人写的文本上用；代码块不走这里。
 */
function stripCommentDecoration(lines) {
  const nonEmpty = lines.filter((line) => line.trim());
  if (!nonEmpty.length) {
    return lines;
  }
  const decorated = nonEmpty.filter((line) => /^\s*(?:\*|\/\/|#)\s?/.test(line)).length;
  let out = lines;
  if (decorated * 2 >= nonEmpty.length) {
    out = out.map((line) => line.replace(/^\s*(?:\*|\/\/|#)\s?/, ""));
  }
  while (out.length && /^\s*\*\/\s*$/.test(out[out.length - 1])) {
    out.pop();
  }
  return out;
}

function trimBlankEdges(lines) {
  const copy = lines.slice();
  while (copy.length && !copy[0].trim()) {
    copy.shift();
  }
  while (copy.length && !copy[copy.length - 1].trim()) {
    copy.pop();
  }
  return copy;
}

/**
 * 提交时用哪段代码：
 * 写了 @pintia code 块就只提交块内，否则提交整个文件。
 * （pintia 插件在缺少 code 块时直接拒绝提交，这里放宽了。）
 */
function getCodeForSubmission(text) {
  const blocks = extractBlocks(text);
  if (blocks.code && blocks.code.trim()) {
    return blocks.code;
  }
  return String(text === null || text === undefined ? "" : text);
}

function buildNoteBlock(language, inner) {
  const style = commentStyle(language);
  const body = String(inner === null || inner === undefined ? "" : inner);
  if (style.block) {
    const lines = [`/* @pintia note=start`];
    if (body.trim()) {
      body.split(/\r?\n/).forEach((line) => lines.push(` * ${line}`.replace(/\s+$/, "")));
    }
    lines.push(` * @pintia note=end */`);
    return lines.join("\n");
  }
  const lines = [`${style.line}@pintia note=start`];
  body.split(/\r?\n/).forEach((line) => {
    if (line.trim()) {
      lines.push(`${style.line}${line}`);
    }
  });
  lines.push(`${style.line}@pintia note=end`);
  return lines.join("\n");
}

/** 源码里没有 note 块时补一个空的（放在文件最前面）。 */
function ensureNoteBlock(language, text) {
  const source = String(text === null || text === undefined ? "" : text);
  if (ANNOTATION.test(source) && extractBlocks(source).notes !== "" ) {
    return source;
  }
  if (/@pintia\s+note\s*=\s*start/.test(source)) {
    return source;
  }
  return `${buildNoteBlock(language, "")}\n\n${source.replace(/^\s*\n/, "")}`;
}

/**
 * 把源码里的 @pintia note 内容同步进 notes.md。
 * notes.md 中 marker 之内的内容是同步区，marker 之外（你自己写的笔记）不动。
 */
async function syncNotesFromCode(sourceText, notesPath) {
  const blocks = extractBlocks(sourceText);
  const note = String(blocks.notes || "").trim();

  let existing = "";
  try {
    existing = await fs.promises.readFile(notesPath, "utf8");
  } catch (_error) {
    existing = "";
  }

  const section = [
    NOTE_SYNC_BEGIN,
    "",
    note || "_（源码里的 @pintia note 块目前是空的）_",
    "",
    NOTE_SYNC_END
  ].join("\n");

  const begin = existing.indexOf(NOTE_SYNC_BEGIN);
  const end = existing.indexOf(NOTE_SYNC_END);
  let next;
  if (begin >= 0 && end > begin) {
    next = `${existing.slice(0, begin)}${section}${existing.slice(end + NOTE_SYNC_END.length)}`;
  } else if (existing.trim()) {
    next = `${existing.replace(/\s+$/, "")}\n\n${NOTE_SECTION_TITLE}\n\n${section}\n`;
  } else {
    next = `${NOTE_SECTION_TITLE}\n\n${section}\n`;
  }

  await fs.promises.mkdir(path.dirname(notesPath), { recursive: true });
  await fs.promises.writeFile(notesPath, next, "utf8");
  return { note, notesPath, changedFromCode: Boolean(note) };
}

module.exports = {
  ANNOTATION,
  NOTE_SYNC_BEGIN,
  NOTE_SYNC_END,
  NOTE_SECTION_TITLE,
  extractBlocks,
  getCodeForSubmission,
  buildNoteBlock,
  ensureNoteBlock,
  syncNotesFromCode
};
