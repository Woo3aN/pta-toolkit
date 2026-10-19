# 第三方代码

本项目自身不依赖任何 npm 包，下面这份代码是为实现「微信扫码登录」而内联进仓库的。

## qrcode-generator

- 文件：`vendor/qrcode.js`
- 版本：1.4.4
- 作者：Kazuhiko Arase
- 许可：MIT
- 来源：<https://github.com/kazuhikoarase/qrcode-generator>
- 用途：把 PTA 返回的微信授权链接编码成二维码，在 VS Code 里展示给用户扫。
  上游代码的许可声明保留在文件头部，未作修改。

选择直接内联而不是加 npm 依赖，是为了保持扩展「零依赖、免编译」——
VS Code 扩展不需要构建步骤就能跑，装 .vsix 也不用联网装包。

## MathJax

- 文件：`vendor/mathjax/tex-svg.js`
- 版本：3（tex-svg 单文件包）
- 作者：MathJax Consortium
- 许可：Apache-2.0
- 来源：<https://www.mathjax.org/> / <https://github.com/mathjax/MathJax>
- 用途：在题目预览面板里渲染题面的 LaTeX 公式。选 `tex-svg.js` 是因为它把字形做成 SVG
  路径内嵌，不依赖额外字体文件，单个文件就能离线工作。
  上游代码未作修改，许可声明保留在文件头部。
