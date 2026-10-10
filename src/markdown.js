"use strict";

/**
 * 极简 Markdown → HTML。
 *
 * PTA 的题面本身是 Markdown（实测），格式可控，所以不需要完整实现，
 * 覆盖标题、段落、列表、代码块、行内代码、粗斜体、链接、图片、表格、数学公式即可。
 * 不依赖任何第三方库，保持「零依赖、免编译」。
 *
 * 处理顺序很重要：先摘出代码块与数学公式（占位），再整体转义，
 * 否则题面里的 `<` `&` 会破坏版面，公式里的下标符号也会被当成 Markdown。
 */

const CODE_PLACEHOLDER = "\u0000B";
const MATH_PLACEHOLDER = "\u0000M";
const PLACEHOLDER_END = "\u0000";

function escapeHtml(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内标记。入参必须是**已转义**的文本。 */
function inline(text) {
  let out = String(text || "");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, '<img alt="$1" src="$2">');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, '<a href="$2">$1</a>');
  out = out.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
  return out;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf("-") >= 0;
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * 把 PTA 题面（Markdown）转成 HTML。
 * @param {string} markdown
 * @returns {string}
 */
function renderMarkdown(markdown) {
  const source = String(markdown === null || markdown === undefined ? "" : markdown).replace(/\r\n?/g, "\n");
  const codeBlocks = [];
  const mathBlocks = [];

  let text = source.replace(/```([A-Za-z0-9+#._-]*)[ \t]*\n([\s\S]*?)```/g, (_match, lang, code) => {
    const language = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre class="code"${language}><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `${CODE_PLACEHOLDER}${codeBlocks.length - 1}${PLACEHOLDER_END}`;
  });

  // 公式先抽出来占位，只记原文；到底按行间还是行内渲染，等看到它在哪一行再决定。
  // 行间公式先于行内公式，避免 $$ 被拆成两个 $
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expression) => {
    mathBlocks.push({ expression: expression.trim(), block: true });
    return `${MATH_PLACEHOLDER}${mathBlocks.length - 1}${PLACEHOLDER_END}`;
  });
  text = text.replace(/\$(\S(?:[^$\n]*\S)?)\$/g, (_match, expression) => {
    mathBlocks.push({ expression, block: false });
    return `${MATH_PLACEHOLDER}${mathBlocks.length - 1}${PLACEHOLDER_END}`;
  });

  text = escapeHtml(text);

  const restoreCodes = (value) =>
    value.replace(new RegExp(`${CODE_PLACEHOLDER}(\\d+)${PLACEHOLDER_END}`, "g"), (_m, index) => codeBlocks[Number(index)] || "");

  /**
   * 行内公式的定界符必须是 \(…\)，不能留 $$…$$。
   *
   * 面板里 MathJax 配的是 displayMath: [['$$','$$']] + inlineMath: [['$','$'], ['\\(','\\)']]，
   * 而它匹配分隔符时**长的优先** —— 所以 $$…$$ 一定会被当成**行间**公式（居中、独占一行）。
   * PTA 题面偏偏爱把 $$…$$ 写在句子中间，比如
   * 「给定两个矩阵$$A$$和$$B$$，求其和矩阵$$C=A+B$$。」。
   * 以前这里只把 class 从 math-block 改成 math-inline、分隔符照旧留着 $$，
   * 于是 MathJax 照旧按行间渲染，一句话被居中切成好几段。
   */
  const mathInlineHtml = (item) => `<span class="math-inline">\\(${escapeHtml(item.expression)}\\)</span>`;
  /** 真正的行间公式：留给 MathJax 按 displayMath 渲染 */
  const mathBlockHtml = (item) => `<span class="math-block">$$${escapeHtml(item.expression)}$$</span>`;

  const restoreMath = (value, render) =>
    restoreCodes(value).replace(new RegExp(`${MATH_PLACEHOLDER}(\\d+)${PLACEHOLDER_END}`, "g"), (_m, index) => {
      const item = mathBlocks[Number(index)];
      return item ? render(item) : "";
    });

  // 段落内部：公式一律行内
  const restoreInline = (value) => restoreMath(value, mathInlineHtml);
  // 独立成行：原本写 $$…$$ 的按行间，单个 $…$ 的仍按行内
  const restoreStandalone = (value) =>
    restoreMath(value, (item) => (item.block ? mathBlockHtml(item) : mathInlineHtml(item)));

  const lines = text.split("\n");
  const out = [];
  let paragraph = [];
  let listType = "";
  let inQuote = false;

  /**
   * 段落 / 表格单元格 / 列表项等处的完整行内渲染：
   * 先做行内标记（粗体、链接、行内代码…），再把代码块与公式的占位符换回来。
   * 两步都要走，否则段落中间的公式会留下占位符。
   */
  const renderInline = (value) => restoreInline(inline(value));

  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join("<br>"))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = "";
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push("</blockquote>");
      inQuote = false;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      closeParagraph();
      closeList();
      closeQuote();
      continue;
    }

    const standalone = /^\u0000[BM]\d+\u0000$/.test(trimmed);
    if (standalone) {
      closeParagraph();
      closeList();
      closeQuote();
      out.push(restoreStandalone(trimmed));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      closeList();
      closeQuote();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      closeParagraph();
      closeList();
      closeQuote();
      out.push("<hr>");
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (trimmed.indexOf("|") >= 0 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      closeParagraph();
      closeList();
      closeQuote();
      const header = splitRow(trimmed);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().indexOf("|") >= 0) {
        rows.push(splitRow(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (unordered || ordered) {
      closeParagraph();
      closeQuote();
      const want = unordered ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${renderInline((unordered ? unordered[1] : ordered[2]).trim())}</li>`);
      continue;
    }

    const quote = /^&gt;\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeParagraph();
      closeList();
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(`<p>${renderInline(quote[1].trim())}</p>`);
      continue;
    }

    closeList();
    closeQuote();
    paragraph.push(trimmed);
  }

  closeParagraph();
  closeList();
  closeQuote();

  return out.join("\n");
}

module.exports = {
  escapeHtml,
  renderMarkdown,
  inline
};
