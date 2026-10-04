"use strict";

/**
 * 编译器表 —— 直接取自 PTA 前端 bundle 里的 `ptaCompiler` 常量（评测机真正用的命令）。
 *
 * 为什么要照抄而不是自己写编译参数：
 *   1. `-DONLINE_JUDGE` 会改变很多竞赛模板的行为（模板常用它关掉调试输出），
 *      本地不带这个宏就会出现「本地对、提交错」。
 *   2. `-fno-tree-ch` 影响 PTA 的计时口径。
 *   3. `-std=c++17` / `-std=c99` 与判题机保持一致，避免语言特性差异。
 *
 * 已实测：这几个参数在本机 g++ 16.1.0 / gcc 16.1.0 上完全可用。
 *
 * `$src` = 源文件，`$exe` = 可执行产物。没有 compileCmd 的是解释型语言。
 */

const PTA_COMPILERS = {
  GCC: {
    name: "GCC",
    ext: "c",
    language: "C",
    displayName: "gcc",
    ptaVersion: "11.4.0",
    compileCmd: "gcc -DONLINE_JUDGE -fno-tree-ch -O2 -Wall -std=c99 -pipe $src -lm -o $exe"
  },
  GXX: {
    name: "GXX",
    ext: "cpp",
    language: "C++",
    displayName: "g++",
    ptaVersion: "11.4.0",
    compileCmd: "g++ -DONLINE_JUDGE -fno-tree-ch -O2 -Wall -std=c++17 -pipe $src -lm -o $exe"
  },
  CLANG: {
    name: "CLANG",
    ext: "clang.c",
    language: "C",
    displayName: "clang",
    ptaVersion: "17.0.6",
    compileCmd: "clang -DONLINE_JUDGE -O2 -Wall -std=c99 -pipe $src -lm -o $exe"
  },
  CLANGXX: {
    name: "CLANGXX",
    ext: "clang.cpp",
    language: "C++",
    displayName: "clang++",
    ptaVersion: "17.0.6",
    compileCmd: "clang++ -DONLINE_JUDGE -O2 -Wall -std=c++17 -pipe $src -lm -o $exe"
  },
  JAVAC: {
    name: "JAVAC",
    ext: "java",
    language: "Java",
    displayName: "javac",
    ptaVersion: "11.0.19",
    compileCmd: "javac -encoding UTF8 $src",
    runCmd: "java Main"
  },
  PYTHON2: {
    name: "PYTHON2",
    ext: "py",
    language: "Python",
    displayName: "python2",
    ptaVersion: "2.7.17",
    runCmd: "python2 $src"
  },
  PYTHON3: {
    name: "PYTHON3",
    ext: "3.py",
    language: "Python",
    displayName: "python3",
    ptaVersion: "3.10.13",
    runCmd: "python3 $src"
  },
  GO: {
    name: "GO",
    ext: "go",
    language: "Go",
    displayName: "go",
    ptaVersion: "1.20.3",
    compileCmd: "go build $src"
  },
  NODE: {
    name: "NODE",
    ext: "js",
    language: "JavaScript",
    displayName: "node",
    ptaVersion: "12.22.12",
    runCmd: "node $src"
  },
  RUST: {
    name: "RUST",
    ext: "rs",
    language: "Rust",
    displayName: "rustc",
    ptaVersion: "1.79.0",
    compileCmd: "rustc --edition=2018 -O --cfg ONLINE_JUDGE $src -o $exe"
  },
  RUBY: {
    name: "RUBY",
    ext: "rb",
    language: "Ruby",
    displayName: "ruby",
    ptaVersion: "2.7.5",
    runCmd: "ruby $src"
  },
  PHP: {
    name: "PHP",
    ext: "php",
    language: "PHP",
    displayName: "php",
    ptaVersion: "7.2.24",
    runCmd: "php $src"
  },
  BASH: {
    name: "BASH",
    ext: "sh",
    language: "Bash",
    displayName: "bash",
    ptaVersion: "4.4.20",
    runCmd: "bash $src"
  },
  LUA: {
    name: "LUA",
    ext: "lua",
    language: "Lua",
    displayName: "lua",
    ptaVersion: "5.2.4",
    runCmd: "lua $src"
  }
};

/** 语言 → 默认编译器（与 PTA 的 langCompilerMapping 一致） */
const DEFAULT_COMPILER_BY_LANGUAGE = {
  "C++": "GXX",
  C: "GCC",
  Java: "JAVAC",
  Python: "PYTHON3"
};

/** PTA 编译器代码 → 它在 PTA 界面上的显示名 */
const COMPILER_DISPLAY_NAME = Object.keys(PTA_COMPILERS).reduce((acc, code) => {
  acc[code] = `${PTA_COMPILERS[code].language} (${PTA_COMPILERS[code].displayName})`;
  return acc;
}, {});

function getCompiler(code) {
  return PTA_COMPILERS[code] || null;
}

function compilerForLanguage(language) {
  return DEFAULT_COMPILER_BY_LANGUAGE[language] || "GXX";
}

/** 按空白切分命令（命令里不含引号嵌套，够用）。 */
function splitCommand(command) {
  return String(command || "")
    .split(/\s+/)
    .filter(Boolean);
}

function substitute(tokens, values) {
  return tokens.map((token) =>
    token.replace(/\$src/g, values.src || "").replace(/\$exe/g, values.exe || "")
  );
}

/**
 * 给 shell 用的引号。题目标题里带空格是常态（如 `Programming in C is fun!`），
 * 而 tasks.json 的 shell 任务把整条命令交给 shell 执行，不加引号会从空格处拆断。
 * 只含安全字符的 token 保持原样，命令才好看得懂。
 * 注意：仅用于 command 字符串；spawn 直传的 args 数组不能加引号。
 */
function shellQuote(token) {
  const text = String(token === null || token === undefined ? "" : token);
  if (!text) {
    return '""';
  }
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

/** 把 token 数组拼成给 shell 执行的命令字符串。 */
function joinCommand(tokens) {
  return (tokens || []).map(shellQuote).join(" ");
}

/**
 * 得到「编译」这一步的程序与参数；解释型语言返回 null。
 * interpreterOverrides 用于把 python2/python3 换成用户机器上真实的解释器路径。
 */
function buildCompile(code, values) {
  const info = PTA_COMPILERS[code];
  if (!info || !info.compileCmd) {
    return null;
  }
  const tokens = substitute(splitCommand(info.compileCmd), values);
  return { program: tokens[0], args: tokens.slice(1), command: joinCommand(tokens) };
}

/** 得到「运行」这一步的程序与参数 */
function buildRun(code, values) {
  const info = PTA_COMPILERS[code];
  if (!info) {
    return null;
  }
  if (info.runCmd) {
    const tokens = substitute(splitCommand(info.runCmd), values);
    const overrides = (values && values.interpreters) || {};
    const base = tokens[0];
    if (overrides[base]) {
      tokens[0] = overrides[base];
    }
    return { program: tokens[0], args: tokens.slice(1), command: joinCommand(tokens) };
  }
  if (values && values.exe) {
    return { program: values.exe, args: [], command: shellQuote(values.exe) };
  }
  return null;
}

module.exports = {
  PTA_COMPILERS,
  DEFAULT_COMPILER_BY_LANGUAGE,
  COMPILER_DISPLAY_NAME,
  getCompiler,
  compilerForLanguage,
  splitCommand,
  shellQuote,
  joinCommand,
  buildCompile,
  buildRun
};
