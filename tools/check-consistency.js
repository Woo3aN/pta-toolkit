#!/usr/bin/env node
"use strict";

/**
 * 一致性检查：package.json 的声明 ↔ extension.js 的注册 ↔ readme 的文档说明。
 *
 * 写这个脚本的原因很实际：readme 里一度写了「本插件不支持提交和测试」，
 * 而实际上它是支持的 —— 文档漂移靠人眼盯不住，靠脚本能。
 *
 * 用法：node tools/check-consistency.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const source = fs.readFileSync(path.join(ROOT, "extension.js"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "readme.md"), "utf8");
const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");

let problems = 0;
const fail = (message) => {
  problems += 1;
  console.log(`  FAIL  ${message}`);
};
const ok = (message) => console.log(`  ok    ${message}`);

const contributes = pkg.contributes || {};
const declared = (contributes.commands || []).map((item) => item.command);
const titleById = new Map((contributes.commands || []).map((item) => [item.command, item.title]));
const registered = [...source.matchAll(/register\("([\w.]+)"/g)].map((match) => match[1]);

const normalize = (text) =>
  String(text)
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .trim();

console.log("1) 命令声明与注册");
{
  const notRegistered = declared.filter((command) => registered.indexOf(command) < 0);
  const notDeclared = registered.filter((command) => declared.indexOf(command) < 0);
  if (notRegistered.length) {
    fail(`package.json 声明了但 extension.js 没注册：${notRegistered.join(", ")}`);
  }
  if (notDeclared.length) {
    fail(`extension.js 注册了但 package.json 没声明：${notDeclared.join(", ")}`);
  }
  if (!notRegistered.length && !notDeclared.length) {
    ok(`${declared.length} 个命令声明与注册一致`);
  }
  if (new Set(declared).size !== declared.length) {
    fail("package.json 里有重复的命令 id");
  }
}

console.log("\n2) 菜单与视图引用");
{
  const menus = contributes.menus || {};
  const menuCommands = new Set();
  Object.keys(menus).forEach((key) => {
    (menus[key] || []).forEach((item) => menuCommands.add(item.command));
  });
  const undeclared = [...menuCommands].filter((command) => declared.indexOf(command) < 0);
  if (undeclared.length) {
    fail(`菜单引用了未声明的命令：${undeclared.join(", ")}`);
  } else {
    ok(`${menuCommands.size} 个菜单命令都有声明`);
  }

  const palette = new Map((menus.commandPalette || []).map((item) => [item.command, item.when]));
  const missingPalette = declared.filter((command) => !palette.has(command));
  if (missingPalette.length) {
    fail(`没有配置命令面板可见性（when）：${missingPalette.join(", ")}`);
  } else {
    const hidden = [...palette.values()].filter((when) => when === "false").length;
    ok(`命令面板全部显式配置（其中 ${hidden} 个是隐藏的内部命令）`);
  }

  const viewIds = new Set();
  Object.keys(contributes.views || {}).forEach((key) => {
    (contributes.views[key] || []).forEach((view) => viewIds.add(view.id));
  });
  const referencedViews = new Set();
  Object.keys(menus).forEach((key) => {
    (menus[key] || []).forEach((item) => {
      const match = String(item.when || "").match(/view\s*==\s*([\w.]+)/);
      if (match) {
        referencedViews.add(match[1]);
      }
    });
  });
  const unknownViews = [...referencedViews].filter((id) => !viewIds.has(id));
  if (unknownViews.length) {
    fail(`菜单引用了未声明的视图：${unknownViews.join(", ")}`);
  } else {
    ok(`视图 ${[...viewIds].join(", ")} 与菜单引用一致`);
  }

  const activitybar = (contributes.viewsContainers || {}).activitybar || [];
  activitybar.forEach((container) => {
    if (container.icon && !fs.existsSync(path.join(ROOT, container.icon))) {
      fail(`活动栏图标文件不存在：${container.icon}`);
    }
  });
}

console.log("\n3) 视图图标文件");
{
  const icons = [];
  Object.keys(contributes.views || {}).forEach((key) => {
    (contributes.views[key] || []).forEach((view) => {
      if (view.icon) {
        icons.push(view.icon);
      }
    });
  });
  const missing = icons.filter((icon) => !fs.existsSync(path.join(ROOT, icon)));
  if (missing.length) {
    fail(`视图图标文件不存在：${missing.join(", ")}`);
  } else if (icons.length) {
    ok(`${icons.length} 个视图图标文件都存在`);
  }
}

console.log("\n4) readme 的命令表与实现");
{
  const documented = [...readme.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)]
    .map((match) => match[1].trim())
    .filter((title) => title.startsWith("PTA:"));
  const titles = [...titleById.values()];
  const normalizedTitles = titles.map(normalize);

  const unknown = documented.filter((title) => normalizedTitles.indexOf(normalize(title)) < 0);
  if (unknown.length) {
    unknown.forEach((title) => fail(`readme 命令表里的「${title}」在 package.json 找不到对应命令`));
  } else {
    ok(`readme 命令表 ${documented.length} 行都能对上真实命令`);
  }

  // 用户界面命令应当都写进 readme（内部命令用 when:false 隐藏的不强求）
  const palette = new Map((contributes.menus.commandPalette || []).map((item) => [item.command, item.when]));
  const userFacing = declared.filter((command) => palette.get(command) !== "false");
  const documentedNorm = documented.map(normalize);
  const undocumented = userFacing.filter((command) => {
    const title = normalize(titleById.get(command));
    return documentedNorm.indexOf(title) < 0;
  });
  if (undocumented.length) {
    fail(`这些命令没写进 readme 命令表：${undocumented.map((c) => titleById.get(c)).join(" / ")}`);
  } else {
    ok(`${userFacing.length} 个用户可见命令都写进了 readme`);
  }
}

console.log("\n5) readme 的配置表与实现");
{
  const keys = Object.keys((contributes.configuration || {}).properties || {});
  const documented = [...readme.matchAll(/^\|\s*`(pta\.[\w.]+)`/gm)].map((match) => match[1]);
  const unknown = documented.filter((key) => keys.indexOf(key) < 0);
  if (unknown.length) {
    unknown.forEach((key) => fail(`readme 配置表里的「${key}」在 package.json 里不存在`));
  }
  const undocumented = keys.filter((key) => documented.indexOf(key) < 0);
  if (undocumented.length) {
    fail(`这些配置项没写进 readme：${undocumented.join(", ")}`);
  }
  if (!unknown.length && !undocumented.length) {
    ok(`配置项 ${keys.length} 个，readme 全部覆盖`);
  }
}

console.log("\n6) 文件与版本");
{
  const version = pkg.version;
  if (!changelog.includes(`[${version}]`)) {
    fail(`CHANGELOG 里没有 ${version} 的记录`);
  } else {
    ok(`CHANGELOG 有 ${version} 的记录`);
  }
  ["LICENSE", "readme.md", "CHANGELOG.md", "extension.js"].forEach((file) => {
    if (!fs.existsSync(path.join(ROOT, file))) {
      fail(`缺少文件：${file}`);
    }
  });
  const publishable = ["src", "snippets", "media", "vendor"].filter(
    (dir) => !fs.existsSync(path.join(ROOT, dir))
  );
  if (publishable.length) {
    fail(`缺少目录：${publishable.join(", ")}`);
  } else {
    ok("核心文件与目录齐全");
  }
}

console.log("\n7) readme 结构完整性");
{
  const toc = [...readme.matchAll(/^\s*-\s*\[(.+?)\]\(#.+?\)\s*$/gm)].map((match) => match[1].trim());
  const headings = readme
    .split("\n")
    .filter((line) => /^#{2,3} /.test(line))
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((name) => name !== "目录");

  const notInToc = headings.filter((name) => toc.indexOf(name) < 0);
  const notInBody = toc.filter((name) => headings.indexOf(name) < 0);
  if (notInToc.length) {
    fail(`readme 有这些小节但目录里没列：${notInToc.join(", ")}`);
  }
  if (notInBody.length) {
    fail(`readme 目录里列了但正文没有：${notInBody.join(", ")}`);
  }
  if (!notInToc.length && !notInBody.length) {
    ok(`目录与 ${headings.length} 个章节一一对应`);
  }

  const required = ["功能特性", "安装", "快速开始", "常见问题", "开发", "致谢", "许可"];
  const missing = required.filter((name) => headings.indexOf(name) < 0);
  if (missing.length) {
    fail(`readme 缺少常见开源项目该有的小节：${missing.join(", ")}`);
  } else {
    ok("常见开源项目的小节都在（功能 / 安装 / 快速开始 / 常见问题 / 开发 / 致谢 / 许可）");
  }

  if (readme.indexOf("\ufffd") >= 0) {
    fail("readme 里有 U+FFFD 替换字符（编码损坏）");
  } else {
    ok("readme 没有编码损坏字符");
  }

  const fences = (readme.match(/^```/gm) || []).length;
  if (fences % 2 !== 0) {
    fail(`readme 里的代码围栏不成对（${fences} 行，应为偶数）`);
  } else {
    ok(`代码围栏成对（${fences} 行）`);
  }
}

console.log("\n8) CHANGELOG 结构与规范");
{
  const allowed = ["新增", "变更", "废弃", "移除", "修复", "安全"];
  const sections = [...changelog.matchAll(/^### (.+)$/gm)].map((match) => match[1].trim());
  const unexpected = [...new Set(sections)].filter((name) => allowed.indexOf(name) < 0);
  if (unexpected.length) {
    fail(
      `CHANGELOG 用了非 Keep a Changelog 的小节：${unexpected.join(", ")}` +
        `（只允许 ${allowed.join(" / ")}，实现说明之类的内容请写进 readme）`
    );
  } else {
    ok(`小节符合 Keep a Changelog（用到：${[...new Set(sections)].join(" / ") || "无"}）`);
  }

  if (!/^## \[Unreleased\]/m.test(changelog)) {
    fail("CHANGELOG 缺少 [Unreleased] 小节");
  } else {
    ok("CHANGELOG 有 [Unreleased] 小节");
  }

  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]);
  if (versions.indexOf(pkg.version) < 0) {
    fail(`CHANGELOG 里没有 ${pkg.version} 的小节`);
  } else {
    ok(`CHANGELOG 有 ${pkg.version} 的小节`);
  }

  // 版本号从新到旧
  const sorted = versions.slice().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (versions.join() !== sorted.join()) {
    fail(`CHANGELOG 的版本顺序不是从新到旧：${versions.join(" -> ")}`);
  } else {
    ok("版本顺序从新到旧");
  }
}

console.log("");
if (problems) {
  console.log(`${problems} 项不一致。`);
  process.exitCode = 1;
} else {
  console.log("全部一致。");
}
