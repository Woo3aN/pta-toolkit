#!/usr/bin/env python3
"""把扩展打包成 .vsix。

VSIX 本质就是一个特定结构的 zip，所以不需要 @vscode/vsce（也就避开了 npm 安装脚本）。
zip 里必须有这三个部分：

    [Content_Types].xml          内容类型声明（根级）
    extension.vsixmanifest       清单，Identity 要与 package.json 的 name/version/publisher 一致
    extension/**                 扩展本体

用法：
    python tools/build-vsix.py
"""

import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent

# 打进 vsix 的条目（目录会递归）
INCLUDE_FILES = [
    "package.json",
    "extension.js",
    "readme.md",
    "LICENSE",
    "CHANGELOG.md",
    "vendor/THIRD-PARTY-NOTICES.md",
]
INCLUDE_DIRS = ["src", "snippets", "media", "vendor"]

CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="gif" ContentType="image/gif"/>
</Types>
"""

MANIFEST = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>{categories}</Categories>
    <Tags>{tags}</Tags>
    <License>LICENSE</License>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def collect_entries():
    """收集要打进包的文件，返回 [(磁盘路径, 包内路径)]，同名只保留一次。"""
    entries = []
    seen = set()

    def add(path, dest):
        if dest in seen:
            return
        seen.add(dest)
        entries.append((path, dest))

    for name in INCLUDE_FILES:
        path = ROOT / name
        if path.is_file():
            add(path, f"extension/{name}")
    for dirname in INCLUDE_DIRS:
        base = ROOT / dirname
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file():
                rel = path.relative_to(ROOT).as_posix()
                add(path, f"extension/{rel}")
    return entries


def main():
    manifest_path = ROOT / "package.json"
    if not manifest_path.is_file():
        print(f"找不到 {manifest_path}", file=sys.stderr)
        return 1

    pkg = json.loads(manifest_path.read_text(encoding="utf-8"))
    name = pkg["name"]
    version = pkg["version"]
    publisher = pkg.get("publisher")
    if not publisher:
        print("package.json 缺少 publisher 字段", file=sys.stderr)
        return 1

    entries = collect_entries()
    if not any(dest == "extension/extension.js" for _, dest in entries):
        print("打包内容里没有 extension.js，检查 package.json 的 main 字段", file=sys.stderr)
        return 1

    manifest = MANIFEST.format(
        name=escape(name),
        version=escape(version),
        publisher=escape(publisher),
        display_name=escape(pkg.get("displayName", name)),
        description=escape(pkg.get("description", "")),
        categories=",".join(pkg.get("categories", ["Other"])),
        tags=",".join(pkg.get("keywords", [])),
        engine=escape((pkg.get("engines") or {}).get("vscode", "*")),
    )

    out_path = ROOT / f"{name}-{version}.vsix"
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("extension.vsixmanifest", manifest)
        for source, dest in entries:
            archive.write(source, dest)

    size_kb = out_path.stat().st_size / 1024
    print(f"已生成 {out_path}  （{size_kb:.1f} KB，{len(entries) + 2} 个条目）")
    print()
    print("安装：")
    print(f'  code --install-extension "{out_path}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
