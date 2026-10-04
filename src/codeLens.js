"use strict";

/**
 * 在题目源码顶部显示一行操作按钮（CodeLens）：
 * 提交 / 在线测试 / 跑本地样例 / 同步笔记 / 打开题面。
 * 只在「所在目录有 .pta.json」的源码文件上出现。
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const METADATA_FILE_NAME = ".pta.json";
const LENS_LANGUAGE_IDS = new Set(["c", "cpp", "python", "java"]);

class PtaCodeLensProvider {
  provideCodeLenses(document) {
    if (!document || !LENS_LANGUAGE_IDS.has(document.languageId)) {
      return [];
    }
    if (document.uri.scheme !== "file") {
      return [];
    }
    const dir = path.dirname(document.uri.fsPath);
    let inProblem = false;
    try {
      inProblem = fs.existsSync(path.join(dir, METADATA_FILE_NAME));
    } catch (_error) {
      inProblem = false;
    }
    if (!inProblem) {
      return [];
    }

    const top = new vscode.Range(0, 0, 0, 0);
    const lens = (title, command, args) => new vscode.CodeLens(top, { title, command, arguments: args });
    return [
      lens("$(cloud-upload) 提交到 PTA", "pta.submitCurrent"),
      lens("$(beaker) 在线测试", "pta.testCurrent"),
      lens("$(play) 跑本地样例", "pta.runSamples"),
      lens("$(note) 同步笔记到 notes.md", "pta.syncNotes"),
      lens("$(book) 打开题面", "pta.openStatement")
    ];
  }
}

module.exports = { PtaCodeLensProvider };
