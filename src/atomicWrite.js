/**
 * 原子写：先写同目录临时文件 → fsync → rename 覆盖目标。
 *
 * 为什么需要：直接 writeFile 时如果进程被强杀 / 断电，目标文件会留下半截内容。
 * 对 `.pta.json`、索引、`tasks.json` 这类结构化文件尤其致命 —— 下次读取直接
 * JSON.parse 失败，等于把用户的题目状态 / 编辑器配置弄坏。
 *
 * rename 在同一分区上是原子的：观察者看到的要么是旧内容，要么是新内容，
 * 不会出现「写了一半」的中间状态。
 *
 * Windows 细节：目标文件可能被杀毒软件或编辑器短暂占用，此时 rename 会
 * 抛 EPERM / EBUSY / EACCES，这里等 50ms 重试一次；临时文件在失败路径上
 * 一定会被清理，不会在用户目录里留垃圾。
 */
const fs = require("fs");
const path = require("path");

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function tempPathFor(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `.${base}.${unique}.tmp`);
}

async function writeFileAtomic(target, data, options) {
  const opts = options || {};
  const encoding = typeof opts === "string" ? opts : opts.encoding || "utf8";
  const tmp = tempPathFor(target);
  let handle = null;
  try {
    handle = await fs.promises.open(tmp, "w");
    await handle.writeFile(data, encoding);
    // 落盘后再 rename：否则断电时可能 rename 成功但内容还在页缓存里
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      await fs.promises.rename(tmp, target);
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error.code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.promises.rename(tmp, target);
    }
    return target;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_error) {
        /* 已经关掉了 */
      }
    }
    try {
      await fs.promises.unlink(tmp);
    } catch (_error) {
      /* rename 成功后临时文件已不存在；也可以是从没创建成功 */
    }
  }
}

async function writeJsonAtomic(target, value, options) {
  return writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

module.exports = { writeFileAtomic, writeJsonAtomic, tempPathFor };
