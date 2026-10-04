"use strict";

/**
 * 微信扫码登录面板（薄壳）：只负责 VS Code 的 WebviewPanel 生命周期，
 * 二维码生成与页面 HTML 在 ./loginView.js（那里不依赖 vscode）。
 *
 * 为什么不让用户去点微信的授权页？那条链接是公众号 OAuth 链接，
 * 在非微信浏览器里会直接显示「抱歉，出错了」，所以必须自己生成二维码。
 */

const vscode = require("vscode");
const view = require("./loginView");

class WechatLoginPanel {
  constructor() {
    this.panel = undefined;
    this.handlers = { onRefresh: undefined, onDispose: undefined };
  }

  isVisible() {
    return Boolean(this.panel);
  }

  show(options) {
    const opts = options || {};
    if (this.panel) {
      this.panel.dispose();
    }

    const panel = vscode.window.createWebviewPanel(
      "ptaWechatLogin",
      "PTA 扫码登录",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = view.buildHtml(opts.qrDataUrl || "", opts.status || "正在获取二维码…");

    panel.webview.onDidReceiveMessage((message) => {
      if (message && message.type === "refresh" && this.handlers.onRefresh) {
        this.handlers.onRefresh();
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.handlers.onDispose) {
        this.handlers.onDispose();
      }
    });

    this.panel = panel;
    this.handlers = { onRefresh: opts.onRefresh, onDispose: opts.onDispose };
    return panel;
  }

  /** 用新的授权链接生成二维码并推给页面 */
  setQr(url) {
    if (!this.panel) {
      return;
    }
    let dataUrl = "";
    try {
      dataUrl = view.qrDataUrl(url);
    } catch (error) {
      this.setStatus(`生成二维码失败：${error.message}`, "error");
      return;
    }
    this.panel.webview.postMessage({ type: "qr", dataUrl });
  }

  setStatus(text, level) {
    if (!this.panel) {
      return;
    }
    this.panel.webview.postMessage({ type: "status", text, level: level || "waiting" });
  }

  dispose() {
    if (this.panel) {
      this.panel.dispose();
    }
    this.panel = undefined;
  }
}

module.exports = { WechatLoginPanel };
