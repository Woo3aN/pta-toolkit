"use strict";

/**
 * 离线测试：验证本地工作区的生成与「不覆盖」规则。
 * 不联网、不依赖 vscode。用法：node test/offline.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ws = require("../src/problemWorkspace");
const notes = require("../src/notes");
const runner = require("../src/runner");
const compilers = require("../src/compilers");
const templates = require("../src/templates");
const api = require("../src/ptaApi");
const library = require("../src/library");
const markdown = require("../src/markdown");
const problemPanel = require("../src/problemPanel");
const taskFile = require("../src/taskFile");
const treeModel = require("../src/treeModel");
const problemInfo = require("../src/problemInfo");

let failed = 0;

function check(label, condition, extra) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra === undefined ? "" : ` -> ${JSON.stringify(extra)}`}`);
  }
}

const fixtureProblem = {
  id: "237",
  label: "练习2-1",
  title: "Programming in C is fun!",
  type: "PROGRAMMING",
  score: 15,
  difficulty: 0,
  author: "admin",
  compiler: "GCC",
  description:
    "本题要求编写程序，输出一个短句“Programming in C is fun!”。\n\n### 输入格式:\n\n本题目没有输入。\n\n### 输出格式:\n\n在一行中输出短句。",
  problemConfig: {
    programmingProblemConfig: {
      timeLimit: 400,
      memoryLimit: 65536,
      exampleTestDatas: [
        { name: "", input: "1 5\n", output: "6\n" },
        { name: "", input: "1 5\n", output: "6\n" },
        { name: "", input: "2 3\n", output: "5\n" }
      ]
    }
  }
};

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pta-toolkit-test-"));
  console.log(`临时工作区：${root}\n`);

  console.log("1) 名称处理");
  check("去掉 Windows 非法字符", ws.sanitizeName('a/b:c*d?e"f<g>h|i') === "a-b-c-d-e-f-g-h-i", ws.sanitizeName('a/b:c*d?e"f<g>h|i'));
  check("保留中文", ws.sanitizeName("练习2-1 Programming in C is fun!").includes("练习2-1"));
  check("去尾部点号", !ws.sanitizeName("abc...").endsWith("."));
  check(
    "超长截断",
    ws.sanitizeName("x".repeat(200)).length <= 60,
    ws.sanitizeName("x".repeat(200)).length
  );
  check(
    "文件夹名模板",
    ws.buildProblemDirName(fixtureProblem, "{label}-{title}") === "练习2-1-Programming in C is fun!",
    ws.buildProblemDirName(fixtureProblem, "{label}-{title}")
  );
  check(
    "pid 模板",
    ws.buildProblemDirName(fixtureProblem, "{pid}") === "237",
    ws.buildProblemDirName(fixtureProblem, "{pid}")
  );

  console.log("\n2) 样例去重");
  const extracted = ws.extractSamples(fixtureProblem);
  check("3 条原始样例去重成 2 条", extracted.samples.length === 2, extracted.samples.length);
  check("重复计数为 1", extracted.duplicates === 1, extracted.duplicates);

  console.log("\n3) HTML 兜底转换");
  const html = "<p>第一行<br>第二行</p><ul><li>要点</li></ul><img src='//static.pintia.cn/a.png'>";
  const converted = ws.htmlToMarkdown(html);
  check("去掉了标签", !/<p>|<br>|<li>/.test(converted), converted);
  check("图片转成 markdown", converted.includes("![](https://static.pintia.cn/a.png)"), converted);
  check("纯 Markdown 原样返回", ws.normalizeStatement("### 输入格式:\n\n无") === "### 输入格式:\n\n无");

  console.log("\n4) 首次生成");
  const first = await ws.ensureProblemWorkspace({
    workspaceRoot: root,
    problemSetId: "12",
    problemSetName: "浙大版《C语言程序设计（第3版）》题目集",
    problem: fixtureProblem,
    language: "C++",
    fileNameFormat: "{label}-{title}",
    url: "https://pintia.cn/problem-sets/12/exam/problems/type/7?problemSetProblemId=237"
  });

  check("problem.md 存在", fs.existsSync(first.statementPath));
  check("notes.md 存在", fs.existsSync(first.notesPath));
  check("源码文件存在", fs.existsSync(first.sourcePath));
  check(".pta.json 存在", fs.existsSync(first.metadataPath));
  check("样例 1.in 存在", fs.existsSync(path.join(first.problemDir, "samples", "1.in")));
  check("样例 2.out 存在", fs.existsSync(path.join(first.problemDir, "samples", "2.out")));
  check("样例文件数为 2*2", fs.readdirSync(path.join(first.problemDir, "samples")).length === 4);
  check("本次创建了源码文件", first.createdSource === true);
  check("本次创建了笔记", first.createdNotes === true);

  const statement = fs.readFileSync(first.statementPath, "utf8");
  check("题面含标题", statement.includes("# 练习2-1 Programming in C is fun!"));
  check("题面含输入格式", statement.includes("### 输入格式:"));
  check("题面含样例小节", statement.includes("## 样例"));
  check("题面含时限", statement.includes("400 ms"));
  check("题面注明样例去重", statement.includes("已去重"));
  check("题面不覆盖提醒", statement.includes("笔记请写在 notes.md"));

  const noteText = fs.readFileSync(first.notesPath, "utf8");
  check("笔记有 frontmatter", noteText.startsWith("---\n"));
  check("笔记含 problemId", noteText.includes('problemId: "237"'));
  check("笔记含 url", noteText.includes("pintia.cn"));
  check("笔记含 tags", noteText.includes("- PTA"));

  const sourceText = fs.readFileSync(first.sourcePath, "utf8");
  check("源码含 @pintia note 块", sourceText.includes("@pintia note=start"));
  check("源码含 main", sourceText.includes("int main()"));

  const meta = JSON.parse(fs.readFileSync(first.metadataPath, "utf8"));
  check("元数据 problemId 正确", meta.problemId === "237", meta.problemId);
  check("元数据记录语言", meta.language === "C++", meta.language);
  check("元数据记录编译器", meta.compiler === "GCC", meta.compiler);
  check("元数据记录时限", meta.timeLimit === 400, meta.timeLimit);
  check("元数据 sampleCount=2", meta.sampleCount === 2, meta.sampleCount);

  console.log("\n5) 重复拉取不覆盖用户内容");
  const userCode = "#include <bits/stdc++.h>\nint main(){ /* 我的代码 */ return 0; }\n";
  const userNote = "\n\n## 我自己的笔记\n\n这里是我的心得。\n";
  fs.writeFileSync(first.sourcePath, userCode, "utf8");
  fs.appendFileSync(first.notesPath, userNote, "utf8");
  fs.writeFileSync(path.join(first.problemDir, "samples", "1.in"), "改过的样例\n", "utf8");

  const second = await ws.ensureProblemWorkspace({
    workspaceRoot: root,
    problemDir: first.problemDir,
    problemSetId: "12",
    problemSetName: "浙大版《C语言程序设计（第3版）》题目集",
    problem: fixtureProblem,
    language: "C++",
    fileNameFormat: "{label}-{title}"
  });

  check("源码未被覆盖", fs.readFileSync(second.sourcePath, "utf8") === userCode);
  check("笔记未被覆盖", fs.readFileSync(second.notesPath, "utf8").includes("我自己的笔记"));
  check("本次没有新建源码", second.createdSource === false);
  check(
    "样例被刷新（跟着 PTA 走）",
    fs.readFileSync(path.join(second.problemDir, "samples", "1.in"), "utf8") === "1 5\n",
    fs.readFileSync(path.join(second.problemDir, "samples", "1.in"), "utf8")
  );

  console.log("\n6) 切换语言不覆盖已有文件");
  const switched = await ws.applyLanguage(first.problemDir, second.metadata, "Python", "");
  check("生成 main.py", fs.existsSync(switched.sourcePath));
  check("main.py 是新文件", switched.created === true);
  check("main.cpp 还在", fs.existsSync(first.sourcePath));
  check("元数据记录两种语言", Boolean(switched.metadata.sourceFiles["C++"] && switched.metadata.sourceFiles.Python));
  const switchedAgain = await ws.applyLanguage(first.problemDir, switched.metadata, "C++", "");
  check("切回 C++ 不覆盖", fs.readFileSync(switchedAgain.sourcePath, "utf8") === userCode);

  console.log("\n7) 题集索引");
  const setDir = ws.buildProblemSetDirectory(root, "12", "浙大版《C语言程序设计（第3版）》题目集");
  const indexPath = await ws.writeProblemSetIndex(setDir, {
    problemSetId: "12",
    problemSetName: "浙大版《C语言程序设计（第3版）》题目集",
    url: "https://pintia.cn/problem-sets/12",
    problems: [
      {
        label: "练习2-1",
        title: "Programming in C is fun!",
        type: "PROGRAMMING",
        problemTypeName: "编程题",
        score: 15,
        dirName: path.basename(first.problemDir)
      }
    ]
  });
  let indexText = fs.readFileSync(indexPath, "utf8");
  check("索引含表格", indexText.includes("| # | 题号 | 标题 |"));
  check("索引含相对链接", indexText.includes("problem.md"));
  check("索引含 marker", indexText.includes(ws.INDEX_BEGIN));

  fs.writeFileSync(indexPath, `${indexText}\n（这是我的备注，别删）\n`, "utf8");
  await ws.writeProblemSetIndex(setDir, {
    problemSetId: "12",
    problemSetName: "浙大版《C语言程序设计（第3版）》题目集",
    problems: [
      {
        label: "练习2-1",
        title: "Programming in C is fun!",
        type: "PROGRAMMING",
        problemTypeName: "编程题",
        score: 15,
        dirName: path.basename(first.problemDir)
      },
      {
        label: "练习2-2",
        title: "新加的一道",
        type: "PROGRAMMING",
        problemTypeName: "编程题",
        score: 10,
        dirName: "练习2-2-新加的一道"
      }
    ]
  });
  indexText = fs.readFileSync(indexPath, "utf8");
  check("刷新后含新题目", indexText.includes("新加的一道"));
  check("刷新后备注保留", indexText.includes("（这是我的备注，别删）"), indexText.slice(-120));
  check("刷新后标题只有一个", indexText.split("浙大版《C语言程序设计（第3版）》题目集").length - 1 === 1);

  console.log("\n8) @pintia 块解析与笔记同步");
  const codeWithBlocks = [
    "/* @pintia note=start",
    " * 用 scanf 读两个数",
    " * @pintia note=end */",
    "#include <stdio.h>",
    "/* @pintia code=start */",
    "int main(){return 0;}",
    "/* @pintia code=end */",
    "/* @pintia test=start",
    "1 5",
    " * @pintia test=end */"
  ].join("\n");

  const blocks = notes.extractBlocks(codeWithBlocks);
  check("解析出 note", blocks.notes === "用 scanf 读两个数", blocks.notes);
  check("解析出 code", blocks.code === "int main(){return 0;}", blocks.code);
  check("解析出 1 个 test 块", blocks.tests.length === 1, blocks.tests);
  check("有 code 块时只提交块内", notes.getCodeForSubmission(codeWithBlocks) === "int main(){return 0;}");
  check("没 code 块时提交整文件", notes.getCodeForSubmission("#include <stdio.h>\nint main(){}") === "#include <stdio.h>\nint main(){}");

  await notes.syncNotesFromCode(codeWithBlocks, first.notesPath);
  const afterSync = fs.readFileSync(first.notesPath, "utf8");
  check("笔记同步进去了", afterSync.includes("用 scanf 读两个数"));
  check("笔记里没有残留注释前缀", !afterSync.includes("* 用 scanf"), afterSync.match(/\* 用 scanf[^\n]*/));
  check("同步区 marker 已写入", afterSync.includes(notes.NOTE_SYNC_BEGIN));
  check("原有笔记还在", afterSync.includes("我自己的笔记"));

  await notes.syncNotesFromCode("/* @pintia note=start\n * 改过的内容\n * @pintia note=end */", first.notesPath);
  const afterSecond = fs.readFileSync(first.notesPath, "utf8");
  check("二次同步覆盖同步区（旧内容被替换）", !afterSecond.includes("用 scanf 读两个数"));
  check("二次同步写入新内容", afterSecond.includes("改过的内容"));
  check("二次同步不产生重复 marker", afterSecond.split(notes.NOTE_SYNC_BEGIN).length - 1 === 1);
  check("二次同步保留手写笔记", afterSecond.includes("我自己的笔记"));

  console.log("\n9) 本地输出比对");
  check("行尾空白忽略", runner.outputsMatch("1 2  \n\n", "1 2\n"));
  check("CRLF 与 LF 等价", runner.outputsMatch("a\r\nb\r\n", "a\nb"));
  check("内容不同则不等", !runner.outputsMatch("1\n", "2\n"));
  check("默认能找到样例对", runner.findSamplePairs(path.join(first.problemDir, "samples")).length === 2);

  console.log("\n10) 模板");
  check("C++ 文件名", templates.sourceFileName("C++") === "main.cpp");
  check("Java 文件名", templates.sourceFileName("Java") === "Main.java");
  check("别名归一化", templates.normalizeLanguage("cpp") === "C++");
  const withNote = notes.ensureNoteBlock("C++", templates.sourceFileContent("C++").content);
  check("补出的 note 块只有一处 start", withNote.split("@pintia note=start").length - 1 === 1);

  console.log("\n11) 登录相关");
  const auth = require("../src/auth");
  const loginView = require("../src/loginView");

  check(
    "从 Set-Cookie 数组里取出 PTASession",
    auth.extractPtaSession({ "set-cookie": ["a=1; Path=/", "PTASession=abc123; Path=/; HttpOnly"] }) ===
      "PTASession=abc123",
    auth.extractPtaSession({ "set-cookie": ["a=1; Path=/", "PTASession=abc123; Path=/; HttpOnly"] })
  );
  check(
    "单条 Set-Cookie 也能取",
    auth.extractPtaSession({ "set-cookie": "x=1; PTASession=zzz9; Path=/" }) === "PTASession=zzz9"
  );
  check("没有 PTASession 时返回空", auth.extractPtaSession({ "set-cookie": ["a=1"] }) === "");
  check("headers 为空不报错", auth.extractPtaSession(null) === "");
  check("扫码状态翻译", auth.describeStatus("WAITING") === "等待扫码…", auth.describeStatus("WAITING"));
  check("成功状态翻译", auth.describeStatus("SUCCESSFUL") === "扫码成功，正在登录…");

  const qr = loginView.qrDataUrl("https://open.weixin.qq.com/connect/oauth2/authorize?appid=x&state=y");
  check("二维码是 GIF data URL", qr.startsWith("data:image/gif;base64,"), qr.slice(0, 32));
  check("二维码内容非空", qr.length > 1000, qr.length);
  check(
    "400 字符的长链接也能编码",
    loginView.qrDataUrl(`https://example.com/?q=${"a".repeat(400)}`).startsWith("data:image/gif;base64,")
  );

  const loginHtml = loginView.buildHtml(qr, "等待扫码…");
  check("页面内嵌二维码", loginHtml.includes(qr.slice(0, 40)));
  check("页面有 CSP", loginHtml.includes("Content-Security-Policy"));
  check("页面有刷新按钮", loginHtml.includes('id="refresh"'));
  check(
    "状态文本做了转义",
    loginView.buildHtml("", "<script>alert(1)</script>").includes("&lt;script&gt;"),
    loginView.buildHtml("", "<script>x</script>").match(/&lt;script&gt;[^<]*/)
  );
  check("每次生成的 nonce 不同", loginView.nonce() !== loginView.nonce());

  console.log("\n12) 编译器命令（照抄 PTA 评测机）");
  const compilers = require("../src/compilers");
  const gxx = compilers.buildCompile("GXX", { src: "main.cpp", exe: ".pta-build/main" });
  check("GXX 用 g++", gxx.program === "g++", gxx.program);
  check("带 -DONLINE_JUDGE", gxx.args.includes("-DONLINE_JUDGE"), gxx.args);
  check("带 -fno-tree-ch", gxx.args.includes("-fno-tree-ch"));
  check("标准是 c++17", gxx.args.includes("-std=c++17"));
  check("$src 已替换", gxx.args.includes("main.cpp"));
  check("$exe 已替换", gxx.args[gxx.args.length - 1] === ".pta-build/main", gxx.args.slice(-2));
  const gcc = compilers.buildCompile("GCC", { src: "main.c", exe: "out" });
  check("GCC 标准是 c99", gcc.args.includes("-std=c99"));
  check("解释型语言没有编译步骤", compilers.buildCompile("PYTHON3", { src: "main.py" }) === null);
  check(
    "python3 会被换成实际解释器",
    compilers.buildRun("PYTHON3", { src: "main.py", interpreters: { python3: "/usr/bin/python3" } }).program ===
      "/usr/bin/python3"
  );
  check(
    "语言→编译器映射",
    compilers.compilerForLanguage("C++") === "GXX" && compilers.compilerForLanguage("Python") === "PYTHON3"
  );
  check("api 层与 compilers 层不重复维护", require("../src/ptaApi").compilerForLanguage("C") === "GCC");

  console.log("\n13) 真跑一遍本地样例（用 PTA 的编译参数）");
  const runDir = path.join(root, "run-test");
  fs.mkdirSync(path.join(runDir, "samples"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "main.cpp"),
    [
      "#include <bits/stdc++.h>",
      "using namespace std;",
      "int main(){",
      "  int a,b; if(!(cin>>a>>b)) return 0;",
      "#ifdef ONLINE_JUDGE",
      '  cout << a+b << endl;',
      "#else",
      '  cout << "DEBUG " << a+b << endl;',
      "#endif",
      "  return 0;",
      "}"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(runDir, "samples", "1.in"), "1 5\n", "utf8");
  fs.writeFileSync(path.join(runDir, "samples", "1.out"), "6\n", "utf8");

  const outcome = await runner.runSamples(runDir, { language: "C++", sourceFileName: "main.cpp" });
  check("编译成功", outcome.compiled === true, outcome.message);
  check("用的是 GXX", outcome.compilerCode === "GXX", outcome.compilerCode);
  check(
    "样例 1 通过",
    outcome.results.length === 1 && outcome.results[0].passed === true,
    outcome.results[0] && outcome.results[0].actual
  );
  check(
    "-DONLINE_JUDGE 真的传给了编译器",
    outcome.results[0] && !/DEBUG/.test(outcome.results[0].actual),
    outcome.results[0] && outcome.results[0].actual
  );

  fs.writeFileSync(
    path.join(runDir, "main.cpp"),
    '#include <cstdio>\nint main(){ printf("999\\n"); return 0; }\n',
    "utf8"
  );
  const wrong = await runner.runSamples(runDir, { language: "C++", sourceFileName: "main.cpp" });
  check("错误答案被判不通过", wrong.results[0] && wrong.results[0].passed === false);
  check("通过数统计正确", wrong.message === "0 / 1 个样例通过", wrong.message);

  const tasks = runner.buildTaskCommands({
    language: "C++",
    sourceFileName: "main.cpp",
    relativeDir: "problem-sets/12-x/练习2-1-y"
  });
  check("tasks 的 build 用 PTA 原命令", tasks.build.includes("-DONLINE_JUDGE"), tasks.build);
  check("tasks 的 run 带样例重定向", tasks.run.includes("samples/1.in"), tasks.run);
  check("tasks 的 run 先编译再运行", tasks.run.includes("&&"), tasks.run);

  console.log("\n14) 收藏夹");
  const favRoot = path.join(root, "fav-test");
  const problemRef = {
    problemSetId: "12",
    problemSetName: "浙大集",
    problemId: "237",
    label: "练习2-1",
    title: "Programming in C is fun!",
    problemType: "PROGRAMMING",
    problemTypeName: "编程题",
    score: 5,
    url: "https://pintia.cn/problem-sets/12"
  };
  check("初始为空", (await library.listFavorites(favRoot)).length === 0);
  const added = await library.toggleFavorite(favRoot, problemRef);
  check("收藏成功", added.favorited === true && added.total === 1, added);
  check("isFavorited 为真", await library.isFavorited(favRoot, problemRef));
  check("收藏文件写在工作区里", fs.existsSync(path.join(favRoot, library.FAVORITES_FILE_NAME)));
  const secondFav = await library.toggleFavorite(
    favRoot,
    Object.assign({}, problemRef, { problemId: "238", label: "练习2-3", title: "输出倒三角图案" })
  );
  check("可以收藏多道", secondFav.total === 2, secondFav.total);
  check("收藏信息完整", (await library.listFavorites(favRoot))[0].title === "输出倒三角图案");
  const removedFav = await library.toggleFavorite(favRoot, problemRef);
  check("再点一次取消收藏", removedFav.favorited === false && removedFav.total === 1, removedFav);
  check("取消后 isFavorited 为假", !(await library.isFavorited(favRoot, problemRef)));
  check("同题同题集才能命中（换题集不误判）", !(await library.isFavorited(favRoot, Object.assign({}, problemRef, { problemSetId: "99" }))));

  console.log("\n15) 做题状态与索引重建");
  check("状态中文：正确", api.problemStatusText("PROBLEM_ACCEPTED") === "答案正确");
  check("状态中文：错误", api.problemStatusText("PROBLEM_WRONG_ANSWER") === "答案错误");
  check("状态缩写：AC", api.problemStatusShort("PROBLEM_ACCEPTED") === "AC");
  check("状态缩写：未作答为 -", api.problemStatusShort("PROBLEM_NO_ANSWER") === "-");
  check("未知状态原样返回", api.problemStatusShort("SOMETHING_NEW") === "SOMETHING_NEW");
  check("空状态为 -", api.problemStatusShort(undefined) === "-");
  check("题号自然排序", ws.compareLabels("练习2-2", "练习2-10") < 0);
  check("中文题号也能排", ws.compareLabels("练习2-1", "练习2-2") < 0);

  const applied = await library.applyProblemStatus(
    root,
    "12",
    "浙大版《C语言程序设计（第3版）》题目集",
    [
      { problemSetProblemId: "237", problemStatus: "PROBLEM_ACCEPTED" },
      { problemSetProblemId: "999999", problemStatus: "PROBLEM_WRONG_ANSWER" }
    ]
  );
  check("只更新本地存在的题目", applied.updated === 1, applied.updated);
  check("索引条目数正确", applied.count === 1, applied.count);
  const indexText2 = fs.readFileSync(
    path.join(ws.buildProblemSetDirectory(root, "12", "浙大版《C语言程序设计（第3版）》题目集"), "index.md"),
    "utf8"
  );
  check("索引含状态列", indexText2.includes("| 状态 |"), indexText2.split("\n")[0]);
  check("索引显示 AC", indexText2.includes("| AC |"), indexText2.split("\n").find((l) => l.startsWith("| 1 ")));
  const metaAfter = JSON.parse(fs.readFileSync(first.metadataPath, "utf8"));
  check("状态写回了 .pta.json", metaAfter.problemStatus === "PROBLEM_ACCEPTED", metaAfter.problemStatus);
  check("并记录中文状态", metaAfter.statusText === "答案正确", metaAfter.statusText);

  console.log("\n16) 侧边栏节点展示");
  const treeModel = require("../src/treeModel");
  check("AC 用实心勾", treeModel.problemIconId("PROBLEM_ACCEPTED") === "pass-filled");
  check("WA 用叉", treeModel.problemIconId("PROBLEM_WRONG_ANSWER") === "close");
  check("未作答用空心圈", treeModel.problemIconId("") === "circle-outline");
  check("AC 用主题的通过色", treeModel.problemThemeColorId("PROBLEM_ACCEPTED") === "testing.iconPassed");
  check("WA 用主题的失败色", treeModel.problemThemeColorId("PROBLEM_WRONG_ANSWER") === "testing.iconFailed");
  check("无状态不加颜色", treeModel.problemThemeColorId("") === null);
  check("题集状态中文", treeModel.problemSetStatusText("PROCESSING") === "进行中");
  check("未知题集状态原样返回", treeModel.problemSetStatusText("WHATEVER") === "WHATEVER");
  check(
    "题集副标题含截止时间",
    treeModel.problemSetDescription({ status: "PROCESSING", endAt: "2026-10-10T12:00:00Z" }).includes("截止 2026-10-10"),
    treeModel.problemSetDescription({ status: "PROCESSING", endAt: "2026-10-10T12:00:00Z" })
  );
  check("公开题集用 library 图标", treeModel.problemSetIconId({ isPublic: true }) === "library");
  check("书本题集用 book 图标", treeModel.problemSetIconId({ type: "BOOK" }) === "book");
  check("其他题集用 folder 图标", treeModel.problemSetIconId({ type: "SET" }) === "folder");
  check(
    "题目标题 = 题号 + 标题",
    treeModel.problemNodeLabel({ label: "练习2-1", title: "Programming in C is fun!" }) ===
      "练习2-1 Programming in C is fun!"
  );
  check("没有标题时用 ID 兜底", treeModel.problemNodeLabel({ id: "237" }) === "237");
  check(
    "副标题 = 状态缩写 + 分值",
    treeModel.problemNodeDescription({ score: 5 }, "PROBLEM_ACCEPTED") === "AC · 5 分",
    treeModel.problemNodeDescription({ score: 5 }, "PROBLEM_ACCEPTED")
  );
  check("没有状态时只显示分值", treeModel.problemNodeDescription({ score: 5 }) === "5 分");
  check("没有分值也没状态时为空", treeModel.problemNodeDescription({}) === "");
  check(
    "提示里带题集名",
    treeModel.problemTooltipLines({ label: "x", title: "y" }, { problemSetName: "浙大集" }).includes("浙大集")
  );
  check(
    "未下载的题目提示可拉取",
    treeModel.problemTooltipLines({ label: "x", title: "y" }, { local: false }).includes("还没拉到本地")
  );
  check(
    "已下载的题目提示直接打开",
    treeModel.problemTooltipLines({ label: "x", title: "y" }, { local: true }).includes("已在本地")
  );

  console.log("\n17) 提交结果的单位换算（PTA 的 time 是秒、memory 是字节）");
  const submitMod = require("../src/submit");
  check("耗时：秒 → 毫秒", submitMod.formatTime(0.314) === "314 ms", submitMod.formatTime(0.314));
  check("内存：字节 → KB", submitMod.formatMemory(434176) === "424 KB", submitMod.formatMemory(434176));
  check("秒会四舍五入", submitMod.formatTime(1.2345) === "1235 ms", submitMod.formatTime(1.2345));
  check("整数分值不显示小数", submitMod.formatScore(20.0) === "20", submitMod.formatScore(20.0));
  check("小数分值保留两位", submitMod.formatScore(13.333) === "13.33", submitMod.formatScore(13.333));
  check("提交时间去掉 T 与 Z", submitMod.formatSubmitAt("2026-10-04T12:05:09Z") === "2026-10-04 12:05:09");
  check(
    "单位换算对空值不报错",
    submitMod.formatTime(null) === "" && submitMod.formatMemory(undefined) === "" && submitMod.formatScore("") === ""
  );

  console.log("\n18) 提交结果报告（提交 / 在线测试 / 最近一次提交 / 提交记录共用）");
  const lastSub = {
    id: "sub-1",
    status: "WRONG_ANSWER",
    score: 10,
    compiler: "GXX",
    time: 0.314,
    memory: 434176,
    submitAt: "2026-10-04T12:00:00Z",
    problemType: "PROGRAMMING",
    hints: { 0: "答案错误" }
  };
  const lastReport = submitMod.buildReport(
    { data: { submission: lastSub }, submissionId: "sub-1" },
    {
      problemTitle: "A+B",
      label: "1001",
      compiler: "GXX",
      totalScore: 20,
      timeLimit: 400,
      memoryLimit: 65536,
      isTest: false
    }
  );
  check("报告含中文状态", lastReport.includes("答案错误"));
  check("报告含得分与总分", lastReport.includes("得分：10 / 20"));
  check("报告含耗时与题目限制", lastReport.includes("耗时：314 ms / 400 ms"), lastReport);
  check("报告含内存与题目限制", lastReport.includes("内存：424 KB / 65536 KB"));
  check("报告含提交 ID", lastReport.includes("sub-1"));
  check("报告含 PTA 给的提示", lastReport.includes("答案错误"));
  check("首行是状态汇总", lastReport.split("\n")[0] === "提交结果：答案错误（WRONG_ANSWER）", lastReport.split("\n")[0]);

  const acceptedReport = submitMod.buildReport(
    { data: { submission: Object.assign({}, lastSub, { status: "ACCEPTED", score: 20 }) } },
    {}
  );
  check("AC 报告正确", acceptedReport.includes("答案正确（ACCEPTED）"), acceptedReport.split("\n")[0]);
  check("没有限制信息时不显示斜杠", !acceptedReport.includes(" / "), acceptedReport);

  const ceReport = submitMod.buildReport(
    {
      data: {
        submission: Object.assign({}, lastSub, {
          status: "COMPILE_ERROR",
          judgeResponseContents: [
            {
              programmingJudgeResponseContent: {
                compilationResult: { success: false, log: "main.cpp:3: error: expected ';'" }
              }
            }
          ]
        })
      }
    },
    {}
  );
  check("编译错误会带出编译日志", ceReport.includes("expected ';'"));
  check("编译错误状态中文", ceReport.includes("编译错误"));

  // 在线测试（自定义测试）的摘要。
  // PTA 对这类不计分的提交回的是 NEUTRAL，以前通知里就原样显示「测试结果：NEUTRAL」，等于没说。
  const testSubmission = Object.assign({}, lastSub, {
    status: "NEUTRAL",
    score: null,
    judgeResponseContents: [
      {
        programmingJudgeResponseContent: {
          compilationResult: { success: true },
          testcaseJudgeResults: { 0: { result: "ACCEPTED", time: 0.1, memory: 4096 } }
        }
      }
    ]
  });
  check("NEUTRAL 有中文名（不再原样漏英文）", api.submissionStatusText("NEUTRAL") === "未评判");
  check(
    "在线测试摘要报测试点，而不是 NEUTRAL",
    submitMod.shortStatusLine({ data: { submission: testSubmission } }, { isTest: true }) ===
      "1 个测试点，全部运行正常",
    submitMod.shortStatusLine({ data: { submission: testSubmission } }, { isTest: true })
  );

  const abnormalSubmission = Object.assign({}, testSubmission, {
    judgeResponseContents: [
      {
        programmingJudgeResponseContent: {
          compilationResult: { success: true },
          testcaseJudgeResults: {
            0: { result: "ACCEPTED" },
            1: { result: "WRONG_ANSWER" },
            2: { result: "SEGMENTATION_FAULT" }
          }
        }
      }
    ]
  });
  check(
    "有异常测试点时点名数量与原因",
    submitMod.shortStatusLine({ data: { submission: abnormalSubmission } }, { isTest: true }) ===
      "3 个测试点，2 个异常（答案错误、段错误）",
    submitMod.shortStatusLine({ data: { submission: abnormalSubmission } }, { isTest: true })
  );
  check(
    "在线测试编译失败时直接说编译错误",
    submitMod.shortStatusLine(
      {
        data: {
          submission: Object.assign({}, testSubmission, {
            judgeResponseContents: [
              { programmingJudgeResponseContent: { compilationResult: { success: false, log: "boom" } } }
            ]
          })
        }
      },
      { isTest: true }
    ) === "编译错误"
  );
  check(
    "没有测试点信息时退回状态中文 + 注明不计分",
    submitMod.shortStatusLine(
      { data: { submission: Object.assign({}, testSubmission, { judgeResponseContents: [] }) } },
      { isTest: true }
    ) === "未评判（自定义测试不计分）"
  );
  check(
    "提交（非测试）的摘要仍然带得分",
    submitMod.shortStatusLine({ data: { submission: lastSub } }, { isTest: false }) === "答案错误，得分 10",
    submitMod.shortStatusLine({ data: { submission: lastSub } }, { isTest: false })
  );

  console.log("\n19) 提交记录筛选（PTA 会忽略按题过滤的参数，只能在本地筛）");
  const submissionsMod = require("../src/submissions");
  const rawSubs = [
    { id: "a", userId: "u1", problemSetProblemId: "237", submitAt: "2026-10-04T10:00:00Z", status: "ACCEPTED", score: 20.0, compiler: "GXX", time: 0.1, memory: 4096 },
    { id: "b", userId: "u2", problemSetProblemId: "237", submitAt: "2026-10-04T11:00:00Z", status: "WRONG_ANSWER", score: 10, compiler: "GXX", time: 0.2, memory: 8192 },
    { id: "c", userId: "u1", problemSetProblemId: "238", submitAt: "2026-10-04T12:00:00Z", status: "ACCEPTED", score: 5, compiler: "PYTHON3", time: 0.3, memory: 12288 },
    { id: "a", userId: "u1", problemSetProblemId: "237", submitAt: "2026-10-04T10:00:00Z", status: "ACCEPTED", score: 20.0, compiler: "GXX", time: 0.1, memory: 4096 }
  ];
  check(
    "按题过滤",
    submissionsMod.filterSubmissions(rawSubs, { problemId: "237" }).length === 3,
    submissionsMod.filterSubmissions(rawSubs, { problemId: "237" }).length
  );
  check(
    "按题 + 按人过滤",
    submissionsMod.filterSubmissions(rawSubs, { problemId: "237", userId: "u1" }).length === 2,
    submissionsMod.filterSubmissions(rawSubs, { problemId: "237", userId: "u1" }).length
  );
  check("不过滤时原样返回", submissionsMod.filterSubmissions(rawSubs, {}).length === 4);
  check("按题号字符串比较（数字与字符串都认）", submissionsMod.filterSubmissions(rawSubs, { problemId: 237 }).length === 3);
  check("能容忍 null 项", submissionsMod.filterSubmissions([null, rawSubs[0]], {}).length === 1);
  check(
    "时间倒序",
    submissionsMod.sortBySubmitAtDesc(rawSubs).map((s) => s.id).join(",") === "c,b,a,a",
    submissionsMod.sortBySubmitAtDesc(rawSubs).map((s) => s.id).join(",")
  );
  check(
    "按 id 去重（分页重叠时用得上）",
    submissionsMod.dedupeById(rawSubs).length === 3,
    submissionsMod.dedupeById(rawSubs).length
  );
  const described = submissionsMod.describeSubmission(rawSubs[0]);
  check("列表行含状态与得分", described.label === "答案正确  20 分", described.label);
  check(
    "列表行含耗时/内存/时间",
    described.description === "100 ms · 4 KB · 2026-10-04 10:00:00",
    described.description
  );
  check("列表行含编译器与提交 ID", described.detail === "GXX · 提交 ID a", described.detail);

  console.log("\n20) 目录 / 文件命名规则与路径安全");
  check("中文原样保留", ws.sanitizeName("计算分段函数", 60) === "计算分段函数");
  check(
    "Windows 非法字符替换为 -",
    ws.sanitizeName('a/b:c*d?e"f<g>h|i', 60) === "a-b-c-d-e-f-g-h-i",
    ws.sanitizeName('a/b:c*d?e"f<g>h|i', 60)
  );
  check("首尾的点与空格去掉", ws.sanitizeName("  ..hello.. ", 60) === "hello", ws.sanitizeName("  ..hello.. ", 60));
  check("内部点保留", ws.buildProblemDirName({ label: "1", title: "a.b.c" }, "{label}-{title}") === "1-a.b.c");
  check("超长按上限截断", ws.sanitizeName("啊".repeat(200), 70).length === 70);
  check("空字符串兜底", ws.sanitizeName("", 60) === "problem");
  check("Windows 保留名 CON 加下划线", ws.sanitizeName("CON", 60) === "CON_");
  check("Windows 保留名 aux（小写）", ws.sanitizeName("aux", 60) === "aux_");
  check("Windows 保留名带扩展名", ws.sanitizeName("nul.txt", 60) === "nul.txt_");
  check("Windows 保留名 com1 / lpt1", ws.sanitizeName("COM1", 60) === "COM1_" && ws.sanitizeName("lpt1", 60) === "lpt1_");
  check("相似但合法的名字不误伤", ws.sanitizeName("console", 60) === "console" && ws.sanitizeName("aux2", 60) === "aux2");
  check(
    "带题号时保留名不会触发（默认格式）",
    ws.buildProblemDirName({ label: "1", title: "CON" }, "{label}-{title}") === "1-CON"
  );
  check(
    "题集目录 = 题集id-题集名（含中文）",
    ws.buildProblemSetDirectory("R:/x", "12", "浙大版《C语言程序设计》题目集").replace(/\\/g, "/") ===
      "R:/x/problem-sets/12-浙大版《C语言程序设计》题目集"
  );
  check(
    "题目目录 = 题号-标题（含空格与中文）",
    ws.buildProblemDirectory("R:/x", "12", "题集名", { label: "练习2-1", title: "Programming in C is fun!" }, "{label}-{title}")
      .replace(/\\/g, "/") === "R:/x/problem-sets/12-题集名/练习2-1-Programming in C is fun!"
  );
  check("自定义格式 {pid} 可用", ws.buildProblemDirName({ problemId: "237", title: "T" }, "{pid}") === "237");

  console.log("\n21) 命令行引号（tasks.json 的 shell 任务）");
  check("安全 token 不加引号", compilers.shellQuote("g++") === "g++");
  check("编译选项不加引号", compilers.shellQuote("-DONLINE_JUDGE") === "-DONLINE_JUDGE");
  check("含空格加双引号", compilers.shellQuote("a b/c.cpp") === '"a b/c.cpp"');
  check("中文路径加双引号", compilers.shellQuote("中文/路径") === '"中文/路径"');
  check("中文加空格加双引号", compilers.shellQuote("中文 路径/x") === '"中文 路径/x"');
  check("全角空格加双引号", compilers.shellQuote("全角　空格") === '"全角　空格"');
  check("shell 元字符加双引号", compilers.shellQuote("a&b") === '"a&b"' && compilers.shellQuote("$x") === '"$x"');
  check("空 token 退化为空引号", compilers.shellQuote("") === '""');
  check("joinCommand 逐个处理", compilers.joinCommand(["g++", "a b.cpp", "-o", "x y"]) === 'g++ "a b.cpp" -o "x y"');

  const rawDir = "problem-sets/12-浙大版《C语言程序设计（第4版）》题目集/练习2-1-Programming in C is fun!";
  const rawCmds = runner.buildTaskCommands({ language: "C++", sourceFileName: "main.cpp", relativeDir: rawDir });
  check("build 命令里源码路径带引号", rawCmds.build.includes(`"${rawDir}/main.cpp"`), rawCmds.build);
  check("build 命令里产物路径带引号", rawCmds.build.includes(`"${rawDir}/.pta-build/main.exe"`), rawCmds.build);
  check("run 命令里样例输入带引号", rawCmds.run.includes(`< "${rawDir}/samples/1.in"`), rawCmds.run);
  const plainCmds = runner.buildTaskCommands({ language: "C++", sourceFileName: "main.cpp" });
  check("路径无特殊字符时命令保持简洁", plainCmds.build.indexOf('"') < 0, plainCmds.build);
  check(
    "spawn 用的 args 不带引号（不能污染真实参数）",
    runner.resolveCommands({ language: "C++", sourceFileName: "main.cpp", relativeDir: rawDir }).compile.args.indexOf(
      `"${rawDir}/main.cpp"`
    ) < 0
  );

  console.log("\n22) 中文 + 空格的路径真跑一遍（防回归）");
  const cnDir = path.join(root, "中文 路径", "12-题集 名称", "练习2-1-Programming in C is fun!");
  fs.mkdirSync(path.join(cnDir, "samples"), { recursive: true });
  fs.writeFileSync(
    path.join(cnDir, "main.cpp"),
    '#include <cstdio>\nint main(){int a,b;if(scanf("%d %d",&a,&b)==2)printf("%d\\n",a+b);else printf("你好\\n");return 0;}\n'
  );
  fs.writeFileSync(path.join(cnDir, "samples", "1.in"), "2 3\n");
  fs.writeFileSync(path.join(cnDir, "samples", "1.out"), "5\n");
  const cnRun = await runner.runSamples(cnDir, { language: "C++", sourceFileName: "main.cpp" });
  check(
    "含空格+中文路径能真实编译并跑过样例",
    Boolean(cnRun.compiled) && cnRun.results.length === 1 && cnRun.results[0].passed,
    cnRun.message || JSON.stringify(cnRun.results)
  );
  check("编译产物落在 .pta-build/", fs.existsSync(path.join(cnDir, ".pta-build", runner.EXE_NAME)));

  fs.writeFileSync(path.join(cnDir, "main.py"), 'import sys\nd=sys.stdin.read().split()\nprint(int(d[0])+int(d[1]) if len(d)>=2 else "你好")\n');
  fs.writeFileSync(path.join(cnDir, "samples", "2.in"), "");
  fs.writeFileSync(path.join(cnDir, "samples", "2.out"), "你好\n");
  const pyRun = await runner.runSamples(cnDir, { language: "Python", sourceFileName: "main.py" });
  check(
    "中文路径下 Python 也能跑（含中文输出比对）",
    Boolean(pyRun.compiled) && pyRun.results.length === 2 && pyRun.results.every((x) => x.passed),
    pyRun.results.map((x) => `${x.passed}:${JSON.stringify(x.actual)}`).join(" ")
  );

  console.log("\n23) 题面 Markdown 渲染（预览面板用）");
  const mdSource = [
    "# 练习2-1 Programming in C is fun!",
    "",
    "本题要求编写程序，输出一个短句“Programming in C is fun!”。",
    "",
    "### 输入格式:",
    "",
    "本题目没有输入。",
    "",
    "```c",
    "int a, b;",
    "```",
    "",
    "- 第一项",
    "- 第二项",
    "",
    "1. 有序一",
    "2. 有序二",
    "",
    "| 列A | 列B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> 引用一行",
    "",
    "公式 $$m \\times n$$ 与行内 $n$ 测试。",
    "",
    "特殊字符 <tag> & \"引号\"，以及 `代码` 与 **加粗**。",
    "",
    "链接 [PTA](https://pintia.cn) 与图片 ![图](https://x/y.png)"
  ].join("\n");
  const mdHtml = markdown.renderMarkdown(mdSource);
  check("一级标题", mdHtml.includes("<h1>练习2-1 Programming in C is fun!</h1>"));
  check("三级标题（输入格式）", mdHtml.includes("<h3>输入格式:</h3>"));
  check("段落", mdHtml.includes("<p>本题目没有输入。</p>"));
  check("无序列表", mdHtml.includes("<ul>") && mdHtml.includes("<li>第一项</li>"));
  check("有序列表", mdHtml.includes("<ol>"));
  check("表格", mdHtml.includes("<table>") && mdHtml.includes("<th>列A</th>"));
  check("围栏代码块（带语言）", mdHtml.includes('<pre class="code" data-lang="c"><code>int a, b;</code></pre>'));
  check("行内代码", mdHtml.includes("<code>代码</code>"));
  check("加粗", mdHtml.includes("<strong>加粗</strong>"));
  check("引用", mdHtml.includes("<blockquote>"));
  check(
    "独占一行的 $$…$$ 保留块级（行间公式）",
    markdown.renderMarkdown("$$m \\times n$$").includes('<span class="math-block">$$m \\times n$$</span>')
  );
  // 行内公式必须改写成 \(…\)：MathJax 分隔符是「长的优先」，
  // 留着 $$…$$ 就一定会被当成行间公式（居中、独占一行），把句子切断。
  check(
    "句子中间的 $$…$$ 改写成行内定界符 \\(…\\)",
    mdHtml.includes('<span class="math-inline">\\(m \\times n\\)</span>')
  );
  check("单个 $…$ 也统一成行内定界符 \\(…\\)", mdHtml.includes('<span class="math-inline">\\(n\\)</span>'));
  check(
    "整句话仍在同一个 <p> 里（公式没把段落切开）",
    /<p>公式 [\s\S]*测试。<\/p>/.test(mdHtml) && !mdHtml.includes('<p><span class="math-block">'),
    mdHtml
  );

  // 真实题面：题集 2097121290578927616「3.0 稀疏矩阵加法」，PTA 把 $$…$$ 写在句子中间。
  // 这段以前会被切成「给定两个矩阵 / A / 和 / B / ，求其和矩阵 / C=A+B / 。」七零八落。
  const realMathLine = "给定两个矩阵$$A$$和$$B$$，求其和矩阵$$C=A+B$$。";
  const realMathHtml = markdown.renderMarkdown(realMathLine);
  check(
    "真实题面：一句话里的多个 $$…$$ 不切段落",
    (realMathHtml.match(/<p>/g) || []).length === 1 && /^<p>给定两个矩阵[\s\S]*。<\/p>$/.test(realMathHtml),
    realMathHtml
  );
  check(
    "真实题面：三个公式全部走行内定界符，一个 $$ 都不留",
    realMathHtml.indexOf("$$") < 0 && (realMathHtml.match(/class="math-inline"/g) || []).length === 3,
    realMathHtml
  );
  check("HTML 被转义（防注入）", mdHtml.includes("&lt;tag&gt;") && !mdHtml.includes("<tag>"));
  check("& 被转义", mdHtml.includes("&amp;"));
  check("链接", mdHtml.includes('<a href="https://pintia.cn">PTA</a>'));
  check("图片", mdHtml.includes('<img alt="图" src="https://x/y.png">'));
  check("段落中的公式占位符被还原（回归）", mdHtml.indexOf("M0") < 0 && mdHtml.indexOf("\u0000") < 0);
  check("空输入不报错", markdown.renderMarkdown("") === "");
  check("裸 HTML 不泄漏为标签", !/<script/i.test(markdown.renderMarkdown("<script>alert(1)</script>")));

  console.log("\n24) 题目预览面板 HTML");
  const panelBase = {
    problem: { label: "练习2-1", title: "Programming in C is fun!", problemSetId: "12", problemId: "237" },
    statement: "# 练习2-1 Programming in C is fun!\n\n### 输出格式:\n\n在一行中输出短句。",
    meta: { problemTypeName: "编程题", score: 15, difficulty: 0, timeLimit: 400, memoryLimit: 65536 },
    workspace: { hasWorkspace: false, language: "C++", sourceFile: "main.cpp", hasNotes: false, problemDir: "" },
    root: ""
  };
  const htmlFresh = problemPanel.buildPanelHtml(panelBase);
  check("未创建时主按钮是「创建代码」", htmlFresh.includes(">创建代码<"), htmlFresh.slice(0, 0));
  check("主按钮发 createWork", htmlFresh.includes('data-command="createWork"'));
  check("没有题解目录时给出引导", htmlFresh.includes("还没有选择题解目录"));
  check("引导里能直接选目录", htmlFresh.includes('data-command="chooseRoot"'));
  check("标题进 HTML", htmlFresh.includes("练习2-1 Programming in C is fun!"));
  check(
    "题面已渲染且标题不重复",
    htmlFresh.includes("在一行中输出短句。") && (htmlFresh.match(/<h1>/g) || []).length === 1,
    (htmlFresh.match(/<h1>/g) || []).length
  );
  check("面板前面显示时限与内存（和题面同一份文案）", htmlFresh.includes("400 ms") && htmlFresh.includes("65536 KB"));
  check("未创建时不显示运行样例", !htmlFresh.includes('data-command="runSamples"'));
  check("面板带 MathJax（含 CSP 许可）", htmlFresh.includes("cdn.jsdelivr.net/npm/mathjax") && htmlFresh.includes("script-src 'unsafe-inline' https://cdn.jsdelivr.net"));
  check("面板脚本用 acquireVsCodeApi", htmlFresh.includes("acquireVsCodeApi"));

  const htmlLocal = problemPanel.buildPanelHtml(
    Object.assign({}, panelBase, {
      root: "R:/pta",
      workspace: {
        hasWorkspace: true,
        language: "C++",
        sourceFile: "main.cpp",
        hasNotes: true,
        problemDir: "R:/pta/problem-sets/12-题集/练习2-1-Programming in C is fun!",
        answerStatus: "AC"
      }
    })
  );
  check("已有本地目录时主按钮是「打开代码」", htmlLocal.includes(">打开代码<"));
  check("已有本地目录时显示题解目录", htmlLocal.includes("R:/pta") && htmlLocal.includes('data-command="chooseRoot"'));
  check("已有本地目录时出现运行样例 / 切换语言", htmlLocal.includes('data-command="runSamples"') && htmlLocal.includes('data-command="switchLanguage"'));
  check("有笔记文件时出现同步笔记", htmlLocal.includes('data-command="syncNotes"'));
  check("显示做题状态徽章", htmlLocal.includes("AC"));
  check("标题含空格时 h1 仍正常", /<h1>[^<]*Programming in C is fun!<\/h1>/.test(htmlFresh));
  check("只剥首个一级标题，后续标题保留", problemPanel.stripLeadingHeading("# T\n\n## 保留我") === "## 保留我");
  check("题面无标题时原样返回", problemPanel.stripLeadingHeading("### 输入格式:\n\n正文") === "### 输入格式:\n\n正文");
  check("骨架页可用", problemPanel.renderPanelSkeleton("x").includes("正在载入题目"));
  check("面板命令清单无重复", new Set(problemPanel.PANEL_COMMANDS).size === problemPanel.PANEL_COMMANDS.length);
  check(
    "面板命令都能在 extension.js 里找到处理分支",
    problemPanel.PANEL_COMMANDS.every((command) =>
      new RegExp(`case "${command}"`).test(require("fs").readFileSync(require("path").join(__dirname, "..", "extension.js"), "utf8"))
    )
  );

  console.log("\n25) .vscode/tasks.json 的合并（防覆盖回归）");
  // 背景：以前这里用一句 try { JSON.parse } catch { /* 没有就新建 */ }，
  // 于是 tasks.json 里只要出现注释（VS Code 允许）就会被当成「文件不存在」，
  // 用户已有的任务被整份清掉。下面这几条守着这个行为。
  const existingTasksText = `${JSON.stringify(
    {
      version: "2.0.0",
      tasks: [{ label: "我的编译任务", type: "shell", command: "g++ x.cpp" }]
    },
    null,
    4
  )}\n`;

  const mergedTasks = taskFile.mergeTasks(
    existingTasksText,
    [{ label: "PTA Build 练习2-1-C++", type: "shell", command: "g++ main.cpp" }],
    { replaceKeys: ["练习2-1-C++"] }
  );
  const mergedTasksJson = JSON.parse(mergedTasks.text);
  check(
    "合并后原有任务还在",
    mergedTasksJson.tasks.some((task) => task.label === "我的编译任务"),
    mergedTasksJson.tasks.map((task) => task.label)
  );
  check(
    "合并后新任务写进去了",
    mergedTasksJson.tasks.some((task) => task.label === "PTA Build 练习2-1-C++")
  );
  check("沿用原文件的 4 空格缩进", mergedTasks.text.indexOf('\n    "') >= 0, mergedTasks.text.slice(0, 30));
  check("末尾保留换行", mergedTasks.text.endsWith("\n"));

  const remerged = taskFile.mergeTasks(mergedTasks.text, [{ label: "PTA Build 练习2-1-C++" }], {
    replaceKeys: ["练习2-1-C++"]
  });
  check(
    "重复合并不会堆叠同一个任务",
    JSON.parse(remerged.text).tasks.filter((task) => task.label === "PTA Build 练习2-1-C++").length === 1,
    remerged.text
  );
  check(
    "保留 inputs 等其它顶层键",
    (() => {
      const kept = JSON.parse(
        taskFile.mergeTasks('{"version":"2.0.0","tasks":[],"inputs":[{"id":"pickFile"}]}', [{ label: "y" }]).text
      );
      return kept.inputs && kept.inputs[0].id === "pickFile";
    })()
  );
  check("文件不存在时用空骨架新建", JSON.parse(taskFile.mergeTasks(null, [{ label: "x" }]).text).tasks.length === 1);

  const commentJson = '{\n  // VS Code 的 tasks.json 支持注释\n  "version": "2.0.0",\n  "tasks": []\n}';
  check(
    "带注释的 tasks.json 会抛错（而不是返回空骨架）",
    (() => {
      try {
        taskFile.mergeTasks(commentJson, [{ label: "x" }]);
        return false;
      } catch (_error) {
        return true;
      }
    })()
  );
  check(
    "顶层不是对象也会抛错",
    (() => {
      try {
        taskFile.mergeTasks("[1, 2]", [{ label: "x" }]);
        return false;
      } catch (_error) {
        return true;
      }
    })()
  );

  // 真的落盘跑一遍：合并失败时磁盘上的文件必须一字未改
  const guardedDir = path.join(root, "tasks-guard");
  fs.mkdirSync(guardedDir, { recursive: true });
  const guardedPath = path.join(guardedDir, "tasks.json");
  fs.writeFileSync(guardedPath, commentJson, "utf8");
  const guarded = await taskFile.mergeTasksFile(guardedPath, [{ label: "x" }]);
  check("合并失败时明确返回失败", guarded.ok === false && typeof guarded.reason === "string");
  check("合并失败后磁盘上的 tasks.json 一字未改", fs.readFileSync(guardedPath, "utf8") === commentJson);

  const freshPath = path.join(guardedDir, "fresh", "tasks.json");
  fs.mkdirSync(path.dirname(freshPath), { recursive: true });
  const fresh = await taskFile.mergeTasksFile(freshPath, [{ label: "新任务" }]);
  check("文件不存在时正常新建并写盘", fresh.ok === true && JSON.parse(fs.readFileSync(freshPath, "utf8")).tasks[0].label === "新任务");

  check("BUILD_DIR_NAME 对外可见（extension.js 要靠它建 .pta-build）", runner.BUILD_DIR_NAME === ".pta-build");
  check(
    "写任务前会先建 .pta-build 目录",
    /problemDir,\s*runner\.BUILD_DIR_NAME/.test(
      fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8")
    )
  );

  console.log("\n26) 题集「已截止」文案");
  const endedBefore = new Date(Date.now() - 86400000).toISOString();
  const endedAfter = new Date(Date.now() + 86400000).toISOString();
  check(
    "endAt 已过去的题集写「已截止」",
    treeModel.problemSetDescription({ status: "PENDING", endAt: endedBefore }) === "已截止",
    treeModel.problemSetDescription({ status: "PENDING", endAt: endedBefore })
  );
  check(
    "状态是 END 时也写「已截止」，不再挂日期",
    treeModel.problemSetDescription({ status: "END", endAt: endedAfter }) === "已截止"
  );
  check(
    "未截止的题集照旧：状态 · 截止 时间",
    treeModel.problemSetDescription({ status: "PROCESSING", endAt: endedAfter }).indexOf("进行中") === 0
  );
  check(
    "未截止的题集仍带截止时间",
    treeModel.problemSetDescription({ status: "PROCESSING", endAt: endedAfter }).includes("截止")
  );
  check("endAt 解析不了时不误判成已截止", treeModel.hasEnded("不是时间") === false);
  check("没有 endAt 时不当已截止", treeModel.hasEnded("") === false);
  check(
    "hasEnded 支持注入当前时间",
    treeModel.hasEnded("2026-10-04T16:00:00Z", Date.parse("2026-10-05T00:00:00Z")) === true
  );
  check("状态 END 的中文是「已截止」", treeModel.problemSetStatusText("END") === "已截止");
  check(
    "选择题集的下拉框复用同一套文案（不再漏出裸英文状态）",
    /description:\s*treeModel\.problemSetDescription\(/.test(
      fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8")
    )
  );

  console.log("\n27) 预览面板 ↔ 工作区根目录 的相互递归（防栈溢出回归）");
  // 背景：peekRoot → resolveCurrentProblem → resolveProblemFromPanel → peekRoot。
  // 「预览面板里有题目」+「没设 pta.workspaceRoot」同时成立就无限递归，
  // 抛 RangeError: Maximum call stack size exceeded（打开题目预览、侧边栏刷新都会踩到）。
  // extension.js 和 src/tree.js 都依赖 vscode，这里把 vscode 换成一个最小替身，
  // 再直接 _compile 真实源码，这样能调真函数、断言真行为。
  function loadWithFakeVscode(relPath, settings, appendSource) {
    const Module = require("module");
    class FakeTreeItem {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    }
    const fakeVscode = {
      window: { activeTextEditor: undefined, showWarningMessage: async () => undefined },
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) => (key in settings ? settings[key] : fallback)
        })
      },
      TreeItem: FakeTreeItem,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class ThemeIcon {
        constructor(id) {
          this.id = id;
        }
      },
      ThemeColor: class ThemeColor {
        constructor(id) {
          this.id = id;
        }
      },
      EventEmitter: class EventEmitter {
        constructor() {
          this.event = () => ({ dispose() {} });
        }
      },
      MarkdownString: class MarkdownString {
        constructor(value) {
          this.value = value;
        }
      },
      Uri: { file: (p) => ({ fsPath: p }) }
    };
    const original = Module._load;
    Module._load = function (request) {
      if (request === "vscode") {
        return fakeVscode;
      }
      return original.apply(this, arguments);
    };
    try {
      const full = path.join(__dirname, "..", relPath);
      const source = fs.readFileSync(full, "utf8") + (appendSource || "");
      const mod = new Module(full, null);
      mod.filename = full;
      mod.paths = Module._nodeModulePaths(path.dirname(full));
      mod._compile(source, full);
      return mod.exports;
    } finally {
      Module._load = original;
    }
  }

  function loadExtensionInternals(settings) {
    return loadWithFakeVscode(
      "extension.js",
      settings,
      "\nmodule.exports.__test = { peekRoot, resolveCurrentProblem, resolveProblemFromPanel, setPanelRef: (r) => { panelProblemRef = r; } };\n"
    ).__test;
  }

  const panelRef = { problemSetId: "12", problemId: "237" };

  const noRoot = loadExtensionInternals({ workspaceRoot: "" });
  noRoot.setPanelRef(panelRef);
  let peekError = null;
  let peekValue = null;
  try {
    peekValue = await noRoot.peekRoot();
  } catch (error) {
    peekError = error;
  }
  check("面板有题目 + 未设根目录：peekRoot 不再炸栈", peekError === null, peekError && peekError.message);
  check("这种情况返回空串（交给上层弹框选目录）", peekValue === "");

  let panelError = null;
  let panelValue = "unset";
  try {
    panelValue = await noRoot.resolveProblemFromPanel();
  } catch (error) {
    panelError = error;
  }
  check("resolveProblemFromPanel 同样不再炸栈", panelError === null, panelError && panelError.message);
  check("没设根目录时它返回 null", panelValue === null);

  const withRoot = loadExtensionInternals({ workspaceRoot: "R:/pta" });
  withRoot.setPanelRef(panelRef);
  check("设了根目录时 peekRoot 照常返回那个目录", (await withRoot.peekRoot()) === "R:/pta");

  const noPanel = loadExtensionInternals({ workspaceRoot: "" });
  noPanel.setPanelRef(null);
  check("面板里没题目时依然返回空串（不会误伤正常路径）", (await noPanel.peekRoot()) === "");

  console.log("\n28) 内置模板、note 块位置、题集没权限时的提示");

  const cppTemplate = templates.sourceFileContent("C++").content;
  check(
    "C++ 模板用 <iostream>，不再是 <bits/stdc++.h>",
    cppTemplate.includes("#include <iostream>") && cppTemplate.indexOf("bits/stdc++") < 0,
    cppTemplate.split("\n")[0]
  );
  check("C++ 模板仍然 using namespace std", cppTemplate.includes("using namespace std;"));

  const cppSource = notes.ensureNoteBlock("C++", cppTemplate);
  check("note 块挪到了文件末尾", cppSource.trimEnd().endsWith("@pintia note=end */"), cppSource);
  check("note 块在 main 之后，不挡着看代码", cppSource.indexOf("@pintia note=start") > cppSource.indexOf("int main()"));
  check("补出来的 note 块仍然只有一处 start", cppSource.split("@pintia note=start").length - 1 === 1);
  check("已经有 note 块时原样返回，不再重复添加", notes.ensureNoteBlock("C++", cppSource) === cppSource);

  const pySource = notes.ensureNoteBlock("Python", templates.sourceFileContent("Python").content);
  check("Python 的 note 块也在末尾", pySource.trimEnd().endsWith("# @pintia note=end"), pySource);

  check(
    "403 被识别成「没权限」",
    treeModel.isForbiddenError({ status: 403 }) === true && treeModel.isForbiddenError({ kind: "forbidden" }) === true
  );
  check(
    "其它错误不算没权限",
    treeModel.isForbiddenError({ status: 500 }) === false && treeModel.isForbiddenError(null) === false
  );
  check(
    "已截止的题集说「已截止」（哪怕 PTA 状态还是 PENDING）",
    treeModel.forbiddenProblemSetMessage({ status: "PENDING", endAt: endedBefore }) === "题集已截止，PTA 不再开放内容"
  );
  check(
    "未开始的题集说「尚未开始」",
    treeModel.forbiddenProblemSetMessage({ status: "PENDING", endAt: endedAfter }) === "题集尚未开始，PTA 暂不开放内容"
  );
  check(
    "状态不明时给通用说法",
    treeModel.forbiddenProblemSetMessage({ status: "PROCESSING", endAt: endedAfter }).includes("没有权限")
  );

  // 行为测试：把 getProblemSummary 换成抛 403，看 setChildren 到底给孩子什么
  const treeModule = loadWithFakeVscode("src/tree.js", {}, "");
  const provider = new treeModule.PtaTreeDataProvider({
    getCookie: async () => "fake-cookie",
    getWorkspaceRoot: async () => "",
    log: () => {}
  });
  const originalGetSummary = api.getProblemSummary;

  api.getProblemSummary = async () => {
    throw new api.PtaError("PTA 返回 403：没有权限（题集可能尚未开始、已结束或未对你开放）。", "forbidden", 403);
  };
  let endedChildren = null;
  try {
    endedChildren = await provider.setChildren({
      setRef: { problemSetId: "1", problemSetName: "x", status: "PENDING", endAt: endedBefore }
    });
  } finally {
    api.getProblemSummary = originalGetSummary;
  }
  check(
    "展开已截止的题集：显示人话，而不是原始 403 错误串",
    endedChildren && endedChildren.length === 1 && endedChildren[0].label === "题集已截止，PTA 不再开放内容",
    endedChildren && endedChildren[0] && endedChildren[0].label
  );
  check(
    "并且不再用红色 error 图标",
    endedChildren && endedChildren[0] && endedChildren[0].iconPath && endedChildren[0].iconPath.id === "lock"
  );

  const provider2 = new treeModule.PtaTreeDataProvider({
    getCookie: async () => "fake-cookie",
    getWorkspaceRoot: async () => "",
    log: () => {}
  });
  api.getProblemSummary = async () => {
    throw new Error("boom");
  };
  let propagated = null;
  try {
    await provider2.setChildren({ setRef: { problemSetId: "2", problemSetName: "y" } });
  } catch (error) {
    propagated = error;
  } finally {
    api.getProblemSummary = originalGetSummary;
  }
  check("非 403 的错误照旧抛出去（没有被顺手吞掉）", propagated !== null && propagated.message === "boom");

  console.log("\n29) 题面文件的信息安排与面板字号");

  // 题面：顶部只留「读题要用」的时限 / 内存，其余元信息收进文件末尾的「## 详细信息」
  const bodyStart = statement.indexOf("## 题目描述");
  const detailStart = statement.indexOf("## 详细信息");
  check("顶部把时限与内存合成一行", statement.includes("> 时间限制 400 ms · 内存限制"));
  check("时限 / 内存排在正文之前", statement.indexOf("> 时间限制") < bodyStart);
  check(
    "顶部不再逐条列元信息",
    bodyStart > 0 && !/^- (题集|题型|分值|作者|本地抓取)/m.test(statement.slice(0, bodyStart)),
    statement.slice(0, bodyStart)
  );
  check("末尾有「## 详细信息」小节", detailStart > bodyStart);
  check("题集挪到了详细信息里", statement.indexOf("- 题集：", detailStart) > 0);
  check("作者 / 来源也挪到了详细信息里", statement.indexOf("- 作者 / 来源：", detailStart) > 0);
  check("在线地址没被删掉，只是挪了位置", statement.indexOf("https://pintia.cn", detailStart) > 0);
  check("本地抓取时间也在详细信息里", statement.indexOf("- 本地抓取：", detailStart) > 0);
  check("详细信息排在样例之后（不挡着读题）", detailStart > statement.indexOf("## 样例"));

  // 面板字号：基准不再完全跟着编辑器的 13px，且标题用 em 一起缩放
  check(
    "面板基准字号至少 15px",
    htmlFresh.includes("font-size: max(15px, var(--vscode-font-size")
  );
  check("正文标题改用 em，跟着基准一起放大", htmlFresh.includes(".statement h2 { font-size: 1.2em;"));
  check("面板标题改用 em", htmlFresh.includes("h1 { font-size: 1.5em;"));
  check("样式里不再有写死的 11px 小字号", htmlFresh.indexOf("font-size: 11px") < 0);

  console.log("\n30) 创建代码之前 / 之后看题目的界面一致");

  // 同一批信息要在两处显示：本地 problem.md（创建之后）与预览面板（创建之前）。
  // 这里直接从两边各自解析出字段列表来比对，防止哪天只改了一边。
  const detailSection = statement.slice(statement.indexOf("## 详细信息"));
  const statementLabels = (detailSection.match(/^- ([^：]+)：/gm) || []).map((line) =>
    line.replace(/^- /, "").replace("：", "")
  );

  const parityMeta = {
    problemTypeName: "PROGRAMMING",
    problemSetName: "浙大版《C语言程序设计（第3版）》题目集",
    problemSetId: "12",
    author: "admin",
    url: "https://pintia.cn/problem-sets/12/exam/problems/type/7?problemSetProblemId=237",
    fetchedAt: "2026-10-10 09:07",
    score: 15,
    difficulty: 0,
    timeLimit: 400,
    memoryLimit: 65536
  };
  const parityHtml = problemPanel.buildPanelHtml({
    problem: { label: "练习2-1", title: "Programming in C is fun!" },
    statement: "本题要求编写程序。",
    meta: parityMeta,
    workspace: { hasWorkspace: false },
    root: ""
  });
  const panelLabels = [...parityHtml.matchAll(/<span class="detail-key">([^<]*)<\/span>/g)].map((m) => m[1]);

  check("题面文件里解析得出「详细信息」字段", statementLabels.length > 0, statementLabels);
  check("面板里也解析得出「详细信息」字段", panelLabels.length > 0, panelLabels);
  check(
    "两处的字段与顺序完全一致",
    statementLabels.join("|") === panelLabels.join("|"),
    `题面=[${statementLabels.join(",")}] 面板=[${panelLabels.join(",")}]`
  );
  check(
    "面板用同一份 limitsText",
    problemInfo.limitsText(parityMeta) === "时间限制 400 ms · 内存限制 65536 KB（64.0 MB）",
    problemInfo.limitsText(parityMeta)
  );
  check(
    "面板前面就有时限与内存（不用先创建代码）",
    parityHtml.indexOf("时间限制") > 0 &&
      parityHtml.indexOf("时间限制") < parityHtml.indexOf('class="statement"')
  );
  check(
    "面板的「详细信息」排在题面之后",
    parityHtml.indexOf('class="details"') > parityHtml.indexOf('class="statement"')
  );
  check("面板详细信息里带上了在线地址", parityHtml.includes("pintia.cn/problem-sets/12"));
  check("难度为 0 时不占一行（两处都不列）", statementLabels.indexOf("难度") < 0 && panelLabels.indexOf("难度") < 0);
  check(
    "字段构成符合约定",
    statementLabels.join("|") === "题集|题型|分值|作者 / 来源|在线地址|本地抓取",
    statementLabels
  );

  console.log("\n31) 面板不再重复显示文件自带的元信息 / 刷新题面真的会刷");

  const newFormat = [
    "# 3.0 稀疏矩阵加法",
    "",
    "> 时间限制 400 ms · 内存限制 65536 KB（64.0 MB）",
    "",
    "---",
    "",
    "## 题目描述",
    "",
    "给定两个矩阵$$A$$和$$B$$。",
    "",
    "## 样例",
    "",
    "### 样例 1",
    "",
    "#### 输入",
    "",
    "```text",
    "1",
    "```",
    "",
    "> 样例已同时写入 `samples/` 目录（`1.in` / `1.out` …），方便本地直接跑。",
    "",
    "## 详细信息",
    "",
    "- 题集：2026实验三（`1`）",
    "- 题型：编程题",
    "- 本地抓取：2026-10-10 09:03",
    "",
    "---",
    "",
    "<!-- 本文件由 PTA Toolkit 生成，每次刷新题面都会重写。笔记请写在 notes.md。 -->",
    ""
  ].join("\n");

  const strippedNew = ws.stripStatementWrapper(newFormat);
  check("新格式：剥掉顶部元信息", !strippedNew.includes("时间限制") && !strippedNew.includes("题集："), strippedNew);
  check("新格式：剥掉末尾的「## 详细信息」", !strippedNew.includes("详细信息"), strippedNew);
  check(
    "新格式：剥掉生成器注释与末尾分隔线",
    !strippedNew.includes("PTA Toolkit 生成") && !/^\s*-{3,}\s*$/m.test(strippedNew),
    strippedNew
  );
  check(
    "新格式：题面正文完好",
    strippedNew.includes("## 题目描述") &&
      strippedNew.includes("给定两个矩阵") &&
      strippedNew.includes("## 样例"),
    strippedNew
  );
  check("新格式：样例说明保留", strippedNew.includes("样例已同时写入"));

  // 旧格式：他手上还压着不少这种文件（顶部是一串 - 题集：… 的 bullet），一样要能剥
  const oldFormat = [
    "# 3.1 最长对称子串",
    "",
    "- 题集：2026实验三 数组和广义表（`1`）",
    "- 题型：编程题",
    "- 分值：25",
    "- 时间限制：400 ms",
    "- 内存限制：65536 KB（64.0 MB）",
    "- 作者 / 来源：陈越",
    "- 在线地址：https://pintia.cn/problem-sets/1/exam/problems/type/7?problemSetProblemId=2",
    "- 本地抓取：2026-10-10 09:02",
    "",
    "---",
    "",
    "## 题目描述",
    "",
    "求最长对称子串。",
    "",
    "> 注：PTA 返回了 2 条样例，其中 1 条完全重复，已去重。",
    "",
    "---",
    "",
    "<!-- 本文件由 PTA Toolkit 生成，每次刷新题面都会重写。笔记请写在 notes.md。 -->",
    ""
  ].join("\n");
  const strippedOld = ws.stripStatementWrapper(oldFormat);
  check(
    "旧格式：那串 - 题集/题型/分值… 的 bullet 也剥得掉",
    !strippedOld.includes("题集：") && !strippedOld.includes("作者 / 来源") && !strippedOld.includes("本地抓取"),
    strippedOld
  );
  check("旧格式：题面正文完好", strippedOld.includes("## 题目描述") && strippedOld.includes("求最长对称子串"), strippedOld);
  check("旧格式：剥完没有多余分隔线", !/^\s*-{3,}\s*$/m.test(strippedOld), strippedOld);

  // 安全阀：不是我们生成的包装就原样返回
  const plain = ["# 我的笔记", "", "第一段正文。", "", "- 这是我自己写的列表", "", "---", "", "第二段正文。", ""].join("\n");
  check("不是生成的包装就不动它", ws.stripStatementWrapper(plain) === plain.trimEnd(), ws.stripStatementWrapper(plain));

  // 面板：本地题面读进来之后不应该再出现文件自带的那批元信息
  const panelHtml = problemPanel.buildPanelHtml({
    problem: { label: "3.1", title: "最长对称子串" },
    statement: strippedOld,
    meta: {
      problemTypeName: "编程题",
      problemSetName: "2026实验三",
      problemSetId: "1",
      author: "陈越",
      url: "https://pintia.cn/x",
      fetchedAt: "2026-10-10 09:03",
      score: 25,
      timeLimit: 400,
      memoryLimit: 65536
    },
    workspace: { hasWorkspace: true, language: "C++", sourceFile: "main.cpp", problemDir: "d:/x", hasNotes: false },
    root: "d:/vscode c++/PTA"
  });
  check("面板里不再出现文件自带的「题集：」", panelHtml.indexOf("题集：") < 0);
  check("面板自己渲染了时限与内存", panelHtml.includes("时间限制") && panelHtml.includes("内存限制"));
  check("面板的详细信息来自 problemInfo", panelHtml.includes('class="details"') && panelHtml.includes('class="limits"'));
  check("题面正文还在", panelHtml.includes("求最长对称子串"));

  // 「刷新题面」按钮：必须真的回 PTA 重拉，而不是把面板按本地文件重画一遍
  const extSource = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
  check(
    "面板的「刷新题面」不再是空操作",
    /case "refresh":[\s\S]{0,220}refreshProblemFromPanel\(ref\)/.test(extSource),
    "case \"refresh\" 分支没接上"
  );
  check(
    "它复用与命令面板同一条刷新路径",
    /async function refreshProblemFromPanel[\s\S]{0,900}refreshProblemWorkspace\(/.test(extSource)
  );

  console.log(`\n${failed === 0 ? "全部通过。" : `${failed} 项失败。`}`);
  console.log(`（临时目录保留在 ${root}，可自行删除）`);
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
