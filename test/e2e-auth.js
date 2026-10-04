"use strict";

/**
 * 登录链路的实网测试（不需要账号，只验证端点契约与错误语义）。
 * 用法：node test/e2e-auth.js
 */

const auth = require("../src/auth");

function line(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  line("1) 取微信授权链接");
  const info = await auth.getWechatAuth();
  console.log(`state = ${info.state}`);
  console.log(`url   = ${info.url.slice(0, 120)}...`);
  if (!/^https:\/\/open\.weixin\.qq\.com\//.test(info.url)) {
    throw new Error("授权链接不是微信的，接口可能变了");
  }

  line("2) 轮询扫码状态（未扫码时）");
  const state = await auth.getWechatAuthState(info.state);
  console.log(JSON.stringify(state));
  if (!state || !state.status) {
    throw new Error("状态接口没有返回 status");
  }

  line("3) 取扫码用户（未扫码时）");
  const user = await auth.getWechatAuthUser(info.state);
  console.log(`user = ${JSON.stringify(user)}（未扫码时为 null 属正常）`);

  line("4) 用假 userId 换 Cookie，应报「第三方登录信息错误」");
  try {
    await auth.loginWithToken(info.state, "0");
    console.log("！！不该成功");
    process.exitCode = 1;
  } catch (error) {
    console.log(`预期的错误：${error.message}`);
  }

  line("5) 账号密码登录，应报「需要图形验证码」");
  try {
    await auth.loginWithPassword({ email: "nobody@example.com", password: "definitely-wrong" });
    console.log("！！不该成功");
    process.exitCode = 1;
  } catch (error) {
    console.log(`kind = ${error.kind}`);
    console.log(`message = ${error.message}`);
  }

  line("6) 二维码生成");
  const dataUrl = require("../src/loginView").qrDataUrl(info.url);
  console.log(`data URL 长度 = ${dataUrl.length}，前缀 = ${dataUrl.slice(0, 30)}`);

  console.log("\n完成：扫码链路可用；密码登录需要图形验证码，插件里做不了。");
}

main().catch((error) => {
  console.error(`\n失败：${error.kind || "unknown"} ${error.message}`);
  process.exitCode = 1;
});
