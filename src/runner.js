"use strict";

/**
 * 本地跑样例：编译 + 用 samples/*.in 作为输入运行 + 对比样例输出。
 *
 * 编译参数不自己写，直接用 PTA 评测机的原命令（见 ./compilers.js），
 * 这样 `-DONLINE_JUDGE`、`-fno-tree-ch`、`-std=c++17` 等都与判题机一致，
 * 避免出现「本地过、提交挂」。
 *
 * 全程异步 spawn，不经过 shell。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const compilers = require("./compilers");

const BUILD_DIR_NAME = ".pta-build";
const EXE_NAME = process.platform === "win32" ? "main.exe" : "main";

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 在常见位置找 Python，找不到就退回 PATH 上的 python。 */
function detectPython(configured) {
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [];
  for (const major of [3, 2]) {
    for (const minor of [14, 13, 12, 11, 10, 9, 8]) {
      const version = `${major}${minor}`;
      candidates.push(path.join(localAppData, "Programs", "Python", `Python${version}`, "python.exe"));
      candidates.push(`C:/Python${version}/python.exe`);
    }
  }
  candidates.push("C:/msys64/ucrt64/bin/python.exe");
  return firstExisting(candidates) || "python";
}

function interpreterOverrides(pythonPath) {
  const python = detectPython(pythonPath);
  return { python, python2: python, python3: python };
}

/**
 * 由 PTA 的编译器命令推导出本机的编译 / 运行命令。
 * relativeDir 为空表示在题目目录内执行（路径不带前缀）；
 * 给了 relativeDir 是给 .vscode/tasks.json 用的（cwd 是工作区根目录）。
 */
function resolveCommands(options) {
  const opts = options || {};
  const code = opts.compilerCode || compilers.compilerForLanguage(opts.language);
  const info = compilers.getCompiler(code);
  if (!info) {
    return null;
  }

  const prefix = opts.relativeDir ? `${opts.relativeDir}/` : "";
  const src = `${prefix}${opts.sourceFileName}`;
  const exe = `${prefix}${BUILD_DIR_NAME}/${EXE_NAME}`;
  const values = { src, exe, interpreters: interpreterOverrides(opts.pythonPath) };

  let compile = compilers.buildCompile(code, values);
  let run = compilers.buildRun(code, values);

  // Java 特例：PTA 的 `javac … $src` 会把 .class 丢在源码旁边，
  // 这里统一收进 .pta-build/，避免题目目录被 .class 弄乱（编译参数本身不变）。
  if (code === "JAVAC") {
    const className = path.basename(opts.sourceFileName, path.extname(opts.sourceFileName));
    const buildDir = `${prefix}${BUILD_DIR_NAME}`;
    compile = {
      program: "javac",
      args: ["-encoding", "UTF8", "-d", buildDir, src],
      command: compilers.joinCommand(["javac", "-encoding", "UTF8", "-d", buildDir, src])
    };
    run = {
      program: "java",
      args: ["-cp", buildDir, className],
      command: compilers.joinCommand(["java", "-cp", buildDir, className])
    };
  }

  return { compilerCode: code, info, compile, run };
}

function runProcess(program, args, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { cwd: opts.cwd, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error.message), spawnError: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer = null;

    const done = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      done({ code: -1, stdout, stderr: `${stderr}${error.message}`, spawnError: true });
    });
    child.on("close", (code) => {
      done({ code, stdout, stderr });
    });

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_error) {
        /* ignore */
      }
      done({ code: -1, stdout, stderr, timedOut: true });
    }, opts.timeout || 10000);

    if (child.stdin) {
      child.stdin.on("error", () => {
        /* 程序不读 stdin 时会 EPIPE，忽略 */
      });
      if (opts.input !== undefined && opts.input !== null) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    }
  });
}

/** 忽略行尾空白与末尾空行后比较，和 OJ 的判定口径接近。 */
function normalizeOutput(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function outputsMatch(actual, expected) {
  return normalizeOutput(actual) === normalizeOutput(expected);
}

function findSamplePairs(samplesDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(samplesDir);
  } catch (_error) {
    return [];
  }
  const inputs = entries
    .filter((name) => name.endsWith(".in"))
    .map((name) => ({ name, index: Number(name.replace(/\.in$/, "")) }))
    .filter((item) => Number.isFinite(item.index))
    .sort((a, b) => a.index - b.index);

  const pairs = [];
  for (const item of inputs) {
    const outputName = `${item.index}.out`;
    if (entries.includes(outputName)) {
      pairs.push({
        index: item.index,
        inputPath: path.join(samplesDir, item.name),
        outputPath: path.join(samplesDir, outputName)
      });
    }
  }
  return pairs;
}

/**
 * 跑题目目录下的全部样例。
 * 返回 { compiled, compileOutput, results, message, allPassed }
 */
async function runSamples(problemDir, options) {
  const opts = options || {};
  const commands = resolveCommands({
    language: opts.language,
    compilerCode: opts.compilerCode,
    sourceFileName: opts.sourceFileName,
    pythonPath: opts.pythonPath
  });
  if (!commands) {
    return { compiled: false, results: [], message: `不支持的语言：${opts.language}` };
  }

  const pairs = findSamplePairs(path.join(problemDir, "samples"));
  if (!pairs.length) {
    return { compiled: false, results: [], message: "这道题没有本地样例文件（samples/ 为空）。" };
  }

  const sourcePath = path.join(problemDir, opts.sourceFileName);
  if (!fs.existsSync(sourcePath)) {
    return { compiled: false, results: [], message: `找不到源码文件：${opts.sourceFileName}` };
  }

  fs.mkdirSync(path.join(problemDir, BUILD_DIR_NAME), { recursive: true });

  if (commands.compile) {
    const compile = await runProcess(commands.compile.program, commands.compile.args, {
      cwd: problemDir,
      timeout: 60000
    });
    if (compile.spawnError) {
      return {
        compiled: false,
        results: [],
        compilerCode: commands.compilerCode,
        command: commands.compile.command,
        message: `找不到编译器「${commands.compile.program}」，请确认它已安装并在 PATH 上。`
      };
    }
    if (compile.code !== 0) {
      return {
        compiled: false,
        compilerCode: commands.compilerCode,
        command: commands.compile.command,
        compileOutput: `${compile.stdout}${compile.stderr}`.trim(),
        results: [],
        message: "编译失败。"
      };
    }
  }

  const results = [];
  for (const pair of pairs) {
    const input = fs.readFileSync(pair.inputPath, "utf8");
    const expected = fs.readFileSync(pair.outputPath, "utf8");
    const run = await runProcess(commands.run.program, commands.run.args, {
      cwd: problemDir,
      input,
      timeout: opts.timeout || 10000
    });
    results.push({
      index: pair.index,
      input,
      expected,
      actual: run.stdout,
      stderr: run.stderr,
      exitCode: run.code,
      timedOut: Boolean(run.timedOut),
      spawnError: Boolean(run.spawnError),
      passed: !run.timedOut && !run.spawnError && run.code === 0 && outputsMatch(run.stdout, expected)
    });
  }

  const passed = results.filter((item) => item.passed).length;
  return {
    compiled: true,
    compilerCode: commands.compilerCode,
    command: commands.compile ? commands.compile.command : commands.run.command,
    results,
    message: `${passed} / ${results.length} 个样例通过`,
    allPassed: passed === results.length
  };
}

/** 生成给 .vscode/tasks.json 用的命令（照 xmuoj 的做法写进任务，而不是自己起进程）。 */
function buildTaskCommands(options) {
  const opts = options || {};
  const commands = resolveCommands({
    language: opts.language,
    compilerCode: opts.compilerCode,
    sourceFileName: opts.sourceFileName,
    relativeDir: opts.relativeDir,
    pythonPath: opts.pythonPath
  });
  if (!commands) {
    return { build: `echo 不支持的语言：${opts.language}`, run: `echo 不支持的语言：${opts.language}` };
  }
  const prefix = opts.relativeDir ? `${opts.relativeDir}/` : "";
  const inputPath = compilers.shellQuote(`${prefix}samples/1.in`);
  const buildCommand = commands.compile
    ? commands.compile.command
    : `echo ${commands.compilerCode} 是解释型语言，无需编译`;
  const runCommand = commands.compile
    ? `${commands.compile.command} && ${commands.run.command} < ${inputPath}`
    : `${commands.run.command} < ${inputPath}`;
  return { build: buildCommand, run: runCommand };
}

module.exports = {
  BUILD_DIR_NAME,
  EXE_NAME,
  detectPython,
  resolveCommands,
  buildTaskCommands,
  runProcess,
  normalizeOutput,
  outputsMatch,
  findSamplePairs,
  runSamples
};
