"use strict";

/**
 * 登录。三种方式，全部围绕 passport.pintia.cn 的接口（接口清单来自 PTA 前端 bundle）：
 *
 *   取二维码链接  GET  /api/oauth/wechat/official-account/auth-url        -> { url, state }
 *   轮询扫码状态  GET  /api/oauth/wechat/official-account/state/{state}   -> { status }
 *   取扫码用户    GET  /api/oauth/wechat/state/{state}/user               -> { user: { id } }
 *   换取 Cookie   POST /api/users/sessions/state/{state}/login_users/{id} -> Set-Cookie: PTASession=...
 *   账号密码登录  POST /api/users/sessions   { email, password, rememberMe, randStr, ticket, ... }
 *                 ⚠️ 需要图形验证码（randStr + ticket），实测直接返回 GATEWAY_WRONG_CAPTCHA，
 *                    所以插件里做不了，只作为「给出准确提示」用。
 *   手机验证码    POST /api/users/mfa/init → /api/users/mfa/{uuid}/sms → /api/users/mfa/{uuid}/sms-check/login
 *                 前置同样要密码，暂未在插件里启用。
 *
 * 结论：**微信扫码是唯一能在编辑器内完整跑完的登录方式**，
 * 扫码之后由扩展自己调 TokenLogin 拿 Cookie，全程不用手动复制 Cookie。
 */

const api = require("./ptaApi");

const WECHAT_STATUS_WAITING = "WAITING";
const WECHAT_STATUS_SUCCESSFUL = "SUCCESSFUL";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 300000;

function passport(path) {
  return `${api.PASSPORT_ORIGIN}${path}`;
}

/** 从响应头里取出 PTASession（Node 会把多个 Set-Cookie 给成数组）。 */
function extractPtaSession(headers) {
  if (!headers) {
    return "";
  }
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of list) {
    const match = String(item).match(/PTASession=[^;,\s]+/);
    if (match) {
      return match[0];
    }
  }
  return "";
}

async function getWechatAuth() {
  const json = await api.requestJson(passport("/api/oauth/wechat/official-account/auth-url"));
  if (!json || !json.url || !json.state) {
    throw new api.PtaError("PTA 没有返回微信授权链接，扫码登录暂时不可用。", "auth");
  }
  return json;
}

async function getWechatAuthState(state) {
  return api.requestJson(
    passport(`/api/oauth/wechat/official-account/state/${encodeURIComponent(state)}`)
  );
}

/** 扫描成功后才有值；未扫码时返回 null。 */
async function getWechatAuthUser(state) {
  const json = await api.requestJson(
    passport(`/api/oauth/wechat/state/${encodeURIComponent(state)}/user`)
  );
  const user = json && json.user ? json.user : json;
  return user && user.id ? user : null;
}

/** 用扫码结果换 Cookie —— 这一步拿到的就是 PTASession。 */
async function loginWithToken(state, loginUserId) {
  const response = await api.rawRequest(
    passport(
      `/api/users/sessions/state/${encodeURIComponent(state)}/login_users/${encodeURIComponent(loginUserId)}`
    ),
    { method: "POST", body: {} }
  );
  const cookie = extractPtaSession(response.headers);
  if (!cookie) {
    throw new api.PtaError("PTA 没有下发 PTASession Cookie，扫码登录失败，请重试。", "auth");
  }
  return cookie;
}

/**
 * 轮询扫码状态直到成功，然后换 Cookie。
 * onStatus 回调收到 PTA 返回的原始状态字符串。
 */
async function waitForWechatScan(state, options) {
  const opts = options || {};
  const interval = opts.intervalMs || DEFAULT_POLL_INTERVAL_MS;
  const timeout = opts.timeoutMs || DEFAULT_POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastStatus = "";

  while (Date.now() - startedAt < timeout) {
    if (opts.isCancelled && opts.isCancelled()) {
      throw new api.PtaError("已取消扫码登录。", "cancelled");
    }
    let payload;
    try {
      payload = await getWechatAuthState(state);
    } catch (error) {
      if (error && (error.kind === "network" || error.kind === "timeout")) {
        await api.sleep(interval);
        continue;
      }
      throw error;
    }

    const status = (payload && payload.status) || "";
    if (status && status !== lastStatus) {
      lastStatus = status;
      if (opts.onStatus) {
        opts.onStatus(status);
      }
    }

    if (status === WECHAT_STATUS_SUCCESSFUL) {
      const user = await getWechatAuthUser(state);
      if (!user) {
        await api.sleep(interval);
        continue;
      }
      const cookie = await loginWithToken(state, user.id);
      return { cookie, user };
    }

    await api.sleep(interval);
  }

  throw new api.PtaError("扫码登录超时，请重新生成二维码。", "timeout");
}

/**
 * 账号密码登录。PTA 现在要求先过图形验证码，
 * 所以这里不指望成功，只负责把「为什么不行」说清楚。
 */
async function loginWithPassword(options) {
  const opts = options || {};
  const body = {
    email: opts.email,
    password: opts.password,
    rememberMe: opts.rememberMe !== false,
    inMiniProgram: false
  };
  try {
    const response = await api.rawRequest(passport("/api/users/sessions"), { method: "POST", body });
    const cookie = extractPtaSession(response.headers);
    if (cookie) {
      return cookie;
    }
    throw new api.PtaError("PTA 没有下发登录 Cookie。", "auth");
  } catch (error) {
    const text = `${(error && error.message) || ""} ${(error && error.code) || ""}`;
    if (/CAPTCHA/i.test(text)) {
      throw new api.PtaError(
        "PTA 要求先通过图形验证码（腾讯 TCaptcha），这一步在插件里没法完成。请改用「微信扫码登录」，或粘贴 Cookie。",
        "captcha"
      );
    }
    throw error;
  }
}

function describeStatus(status) {
  switch (status) {
    case WECHAT_STATUS_WAITING:
      return "等待扫码…";
    case WECHAT_STATUS_SUCCESSFUL:
      return "扫码成功，正在登录…";
    default:
      return status ? `状态：${status}` : "等待扫码…";
  }
}

module.exports = {
  WECHAT_STATUS_WAITING,
  WECHAT_STATUS_SUCCESSFUL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  extractPtaSession,
  getWechatAuth,
  getWechatAuthState,
  getWechatAuthUser,
  loginWithToken,
  waitForWechatScan,
  loginWithPassword,
  describeStatus
};
