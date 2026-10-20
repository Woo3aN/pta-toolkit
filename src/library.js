"use strict";

/**
 * 附加能力：本地收藏、跨题集搜索索引、做题状态落盘与索引重建。
 *
 * 设计取舍：
 *   - 收藏和索引都写在题解工作区里（不是编辑器全局状态），这样能跟着 Git 走，
 *     换电脑 / 多机同步时收藏夹也一起过去。
 *   - 索引是「从磁盘读 .pta.json 生成」的，因此索引永远和本地实际文件一致，
 *     不会出现「索引里有、文件夹却没拉下来」的错位。
 *
 * 不依赖 vscode，方便单测。
 */

const fs = require("fs");
const path = require("path");

const api = require("./ptaApi");
const ws = require("./problemWorkspace");
const atomicWrite = require("./atomicWrite");

const FAVORITES_FILE_NAME = ".pta-favorites.json";
const SEARCH_CACHE_FILE_NAME = ".pta-search-index.json";

/* ------------------------------------------------------------------ */
/* 收藏                                                                */
/* ------------------------------------------------------------------ */

function keyOf(problem) {
  return `${problem.problemSetId}:${problem.problemId}`;
}

function emptyFavorites() {
  return { version: 1, updatedAt: new Date().toISOString(), problems: [] };
}

async function loadFavorites(root) {
  if (!root) {
    return emptyFavorites();
  }
  try {
    const data = JSON.parse(await fs.promises.readFile(path.join(root, FAVORITES_FILE_NAME), "utf8"));
    if (!data || !Array.isArray(data.problems)) {
      return emptyFavorites();
    }
    return data;
  } catch (_error) {
    return emptyFavorites();
  }
}

async function saveFavorites(root, data) {
  const target = path.join(root, FAVORITES_FILE_NAME);
  await fs.promises.mkdir(root, { recursive: true });
  const payload = Object.assign({}, data, { version: 1, updatedAt: new Date().toISOString() });
  await atomicWrite.writeJsonAtomic(target, payload);
  return target;
}

async function isFavorited(root, problem) {
  const data = await loadFavorites(root);
  const key = keyOf(problem);
  return data.problems.some((item) => keyOf(item) === key);
}

/** 收藏 / 取消收藏，返回 { favorited, total } */
async function toggleFavorite(root, problem) {
  const data = await loadFavorites(root);
  const key = keyOf(problem);
  const index = data.problems.findIndex((item) => keyOf(item) === key);
  let favorited;
  if (index >= 0) {
    data.problems.splice(index, 1);
    favorited = false;
  } else {
    data.problems.push({
      problemSetId: String(problem.problemSetId),
      problemSetName: problem.problemSetName || "",
      problemId: String(problem.problemId),
      label: problem.label || "",
      title: problem.title || "",
      problemType: problem.problemType || "PROGRAMMING",
      problemTypeName: problem.problemTypeName || "",
      score: problem.score === undefined ? null : problem.score,
      url: problem.url || "",
      addedAt: new Date().toISOString()
    });
    favorited = true;
  }
  await saveFavorites(root, data);
  return { favorited, total: data.problems.length };
}

async function listFavorites(root) {
  const data = await loadFavorites(root);
  return data.problems.slice().sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
}

/* ------------------------------------------------------------------ */
/* 索引重建 / 做题状态落盘                                              */
/* ------------------------------------------------------------------ */

/** 在本地找某个题集的目录（题集名可能变，所以按 ID 前缀匹配） */
async function findLocalProblemSetDir(root, problemSetId) {
  if (!root) {
    return "";
  }
  const setsRoot = path.join(root, ws.PROBLEM_SET_DIR_NAME);
  let names = [];
  try {
    names = await fs.promises.readdir(setsRoot);
  } catch (_error) {
    return "";
  }
  const match = names.find(
    (name) => name === String(problemSetId) || name.startsWith(`${problemSetId}-`)
  );
  return match ? path.join(setsRoot, match) : "";
}

/** 从磁盘上的 .pta.json 重新生成题集索引 */
async function rebuildIndex(root, problemSetId, problemSetName) {
  const setDir = ws.buildProblemSetDirectory(root, problemSetId, problemSetName);
  const entries = await ws.readProblemSetEntries(setDir);
  if (!entries.length) {
    return { indexPath: "", count: 0 };
  }
  const indexPath = await ws.writeProblemSetIndex(setDir, {
    problemSetId,
    problemSetName: problemSetName || (entries[0].metadata.problemSetName || problemSetId),
    url: api.buildProblemSetUrl(problemSetId),
    problems: entries.map((entry) => ws.toIndexEntry(entry))
  });
  return { indexPath, count: entries.length };
}

/**
 * 把一个题集的做题状态写回各题的 .pta.json，并重建索引。
 * statusList 来自 ptaApi.getExamProblemStatus。
 */
async function applyProblemStatus(root, problemSetId, problemSetName, statusList) {
  const byProblemId = new Map();
  for (const item of statusList || []) {
    const id = String(item.problemSetProblemId || item.problemId || item.id || "");
    if (id) {
      byProblemId.set(id, item);
    }
  }

  const setDir = ws.buildProblemSetDirectory(root, problemSetId, problemSetName);
  const entries = await ws.readProblemSetEntries(setDir);
  let updated = 0;

  for (const entry of entries) {
    const status = byProblemId.get(String(entry.metadata.problemId));
    if (!status) {
      continue;
    }
    const raw = status.problemStatus || status.status || "";
    const next = Object.assign({}, entry.metadata, {
      problemStatus: raw,
      statusShort: api.problemStatusShort(raw),
      statusText: api.problemStatusText(raw),
      statusUpdatedAt: new Date().toISOString()
    });
    await ws.writeMetadata(entry.problemDir, next);
    updated += 1;
  }

  const index = await rebuildIndex(root, problemSetId, problemSetName);
  return { updated, ...index };
}

/* ------------------------------------------------------------------ */
/* 跨题集搜索索引                                                      */
/* ------------------------------------------------------------------ */

async function loadSearchCache(root) {
  try {
    const data = JSON.parse(await fs.promises.readFile(path.join(root, SEARCH_CACHE_FILE_NAME), "utf8"));
    if (data && Array.isArray(data.problems) && data.problems.length) {
      return data;
    }
  } catch (_error) {
    /* 没有缓存 */
  }
  return null;
}

async function saveSearchCache(root, problems) {
  const target = path.join(root, SEARCH_CACHE_FILE_NAME);
  await fs.promises.mkdir(root, { recursive: true });
  const payload = { version: 1, fetchedAt: new Date().toISOString(), problems };
  await atomicWrite.writeJsonAtomic(target, payload);
  return target;
}

/**
 * 拉取「我的题集」里所有题目的清单，作为搜索索引。
 * 题集多的时候请求量不小，支持进度回调与中断。
 */
async function buildSearchIndex(options) {
  const opts = options || {};
  const interval = opts.interval === undefined ? 600 : opts.interval;
  const problemSets = await api.getMyProblemSets(opts.cookie, { onlyActive: false });
  const problems = [];

  for (const problemSet of problemSets) {
    if (opts.isCancelled && opts.isCancelled()) {
      break;
    }
    if (opts.onProgress) {
      opts.onProgress(`正在读取：${problemSet.name || problemSet.id}`);
    }
    let summaries = {};
    try {
      summaries = await api.getProblemSummary(problemSet.id, opts.cookie);
    } catch (_error) {
      continue;
    }
    const types = Object.keys(summaries).filter((type) => api.SAMPLE_BEARING_TYPES.indexOf(type) >= 0);
    for (const type of types) {
      try {
        const list = await api.getAllProblems(problemSet.id, type, opts.cookie, { interval });
        list.forEach((problem) => {
          problems.push({
            problemSetId: String(problemSet.id),
            problemSetName: problemSet.name || problemSet.id,
            problemId: String(problem.id),
            label: problem.label || "",
            title: problem.title || "",
            problemType: problem.type || type,
            problemTypeName: api.problemTypeName(problem.type || type),
            score: problem.score === undefined ? null : problem.score
          });
        });
      } catch (_error) {
        /* 单个题集读不到就跳过 */
      }
    }
  }

  return problems;
}

module.exports = {
  FAVORITES_FILE_NAME,
  SEARCH_CACHE_FILE_NAME,
  keyOf,
  loadFavorites,
  saveFavorites,
  isFavorited,
  toggleFavorite,
  listFavorites,
  findLocalProblemSetDir,
  rebuildIndex,
  applyProblemStatus,
  loadSearchCache,
  saveSearchCache,
  buildSearchIndex
};
