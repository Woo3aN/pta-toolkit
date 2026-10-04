"use strict";

/**
 * 扫码登录面板的「纯函数」部分：二维码生成 + 页面 HTML。
 * 这里不依赖 vscode，方便脱离编辑器做测试。
 */

const qrcode = require("../vendor/qrcode.js");

function nonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** 把文本编码成二维码，返回 data URL（GIF）。 */
function qrDataUrl(text, cellSize, margin) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  const qr = qrcode(0, "M");
  qr.addData(String(text === null || text === undefined ? "" : text));
  qr.make();
  return qr.createDataURL(cellSize || 5, margin === undefined ? 20 : margin);
}

function escapeHtml(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(qrDataUrlValue, statusText) {
  const scriptNonce = nonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
<title>PTA 扫码登录</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }
  h1 { font-size: 16px; font-weight: 500; margin: 0; }
  .qr {
    background: #ffffff;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    line-height: 0;
  }
  .qr img { width: 280px; height: 280px; display: block; }
  .status { font-size: 13px; min-height: 20px; }
  .status.waiting { color: var(--vscode-descriptionForeground); }
  .status.done { color: var(--vscode-terminal-ansiGreen, #3fb950); }
  .status.error { color: var(--vscode-errorForeground, #f85149); }
  ol { font-size: 13px; color: var(--vscode-descriptionForeground); margin: 0; padding-left: 20px; line-height: 1.8; }
  button {
    font-family: inherit;
    font-size: 13px;
    padding: 6px 14px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .hint { font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; max-width: 360px; line-height: 1.6; }
</style>
</head>
<body>
  <h1>用微信扫码登录拼题A</h1>
  <div class="qr"><img id="qr" src="${qrDataUrlValue}" alt="登录二维码"></div>
  <p class="status waiting" id="status">${escapeHtml(statusText)}</p>
  <ol>
    <li>打开微信 → 扫一扫</li>
    <li>扫描上方二维码</li>
    <li>在微信里点「允许」完成登录</li>
  </ol>
  <button id="refresh">二维码过期了？点这里刷新</button>
  <p class="hint">扫不了码也可以用命令「PTA: 粘贴 Cookie 登录」，
  或先在浏览器里登录 pintia.cn 再回来粘贴 Cookie。</p>
<script nonce="${scriptNonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'qr' && message.dataUrl) {
      document.getElementById('qr').src = message.dataUrl;
    }
    if (message.type === 'status') {
      const el = document.getElementById('status');
      el.textContent = message.text;
      el.className = 'status ' + (message.level || 'waiting');
    }
  });
</script>
</body>
</html>`;
}

module.exports = { nonce, qrDataUrl, escapeHtml, buildHtml };
