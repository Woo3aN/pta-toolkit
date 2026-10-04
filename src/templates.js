"use strict";

const fs = require("fs");
const path = require("path");

const LANGUAGE_FILES = {
  "C++": "main.cpp",
  C: "main.c",
  Python: "main.py",
  Java: "Main.java"
};

const LANGUAGE_ALIAS = {
  "c++": "C++",
  cpp: "C++",
  "g++": "C++",
  cxx: "C++",
  c: "C",
  "gcc": "C",
  python: "Python",
  python3: "Python",
  py: "Python",
  java: "Java"
};

const BUILTIN_TEMPLATES = {
  "C++": [
    "#include <bits/stdc++.h>",
    "using namespace std;",
    "",
    "int main() {",
    "",
    "",
    "    return 0;",
    "}",
    ""
  ].join("\n"),
  C: [
    "#include <stdio.h>",
    "",
    "int main() {",
    "",
    "",
    "    return 0;",
    "}",
    ""
  ].join("\n"),
  Python: [
    "import sys",
    "",
    "",
    "def main():",
    "    data = sys.stdin.read().split()",
    "",
    "",
    "main()",
    ""
  ].join("\n"),
  Java: [
    "import java.io.*;",
    "import java.util.*;",
    "",
    "public class Main {",
    "    public static void main(String[] args) throws IOException {",
    "        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));",
    "",
    "    }",
    "}",
    ""
  ].join("\n")
};

function normalizeLanguage(input) {
  if (!input) {
    return "C++";
  }
  const key = String(input).trim();
  if (LANGUAGE_FILES[key]) {
    return key;
  }
  const alias = LANGUAGE_ALIAS[key.toLowerCase()];
  return alias || "C++";
}

function supportedLanguages() {
  return Object.keys(LANGUAGE_FILES);
}

function sourceFileName(language) {
  return LANGUAGE_FILES[normalizeLanguage(language)] || "main.txt";
}

/**
 * 取新建源码文件的内容。优先使用 templateDir/<语言对应文件名>，
 * 读不到再退回内置最小模板。永不抛错。
 */
function sourceFileContent(language, templateDir) {
  const lang = normalizeLanguage(language);
  if (templateDir) {
    const candidate = path.join(templateDir, sourceFileName(lang));
    try {
      const text = fs.readFileSync(candidate, "utf8");
      if (text && text.trim()) {
        return { content: text, from: candidate };
      }
    } catch (_error) {
      /* 没有自定义模板，用内置的 */
    }
  }
  return { content: BUILTIN_TEMPLATES[lang] || "", from: null };
}

module.exports = {
  LANGUAGE_FILES,
  BUILTIN_TEMPLATES,
  normalizeLanguage,
  supportedLanguages,
  sourceFileName,
  sourceFileContent
};
