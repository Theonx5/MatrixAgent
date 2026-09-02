#!/usr/bin/env python3
"""Matrix Agent 发布脚本：从构建产物目录生成 latest.json 并装配分发目录。

Tauri updater 约定：latest.json 列出当前版本各平台的更新包 URL 与 minisign 签名，
客户端比对版本号后下载、验签、安装。本脚本负责把 tauri-action 的产物（.exe/.app.tar.gz
+ .sig）装配成服务端 {MATRIX_AGENT_DIST_DIR} 的磁盘布局：

    {target}/latest.json
    {target}/v{version}/MatrixAgent_*_x64-setup.exe        Windows 10/11 首装+更新
    {target}/v{version}/MatrixAgent_*_aarch64.dmg          macOS Apple Silicon 首装
    {target}/v{version}/MatrixAgent_*_aarch64.app.tar.gz   macOS Apple Silicon 更新

用法（本地手动发布，或 GitHub Actions publish job 内调用）：

    python3 publish.py \
        --artifacts <tauri 构建产物目录> \
        --version 1.2.0 \
        --base-url https://papermatrix.online \
        --target /home/theonx/servers-PaperDownload-prod/matrix-agent_dist \
        [--notes "更新说明（可多行）"]

平台归类规则（按文件名小写匹配）：
    *.exe                          -> windows-x86_64
    *aarch64*.app.tar.gz           -> darwin-aarch64
签名取同名 +".sig" 文件内容；.dmg 无签名（仅首装用，不进 updater 清单）。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import shutil
import sys
from pathlib import Path

# Tauri v2 updater 的平台键 -> 产物文件名匹配规则（update 包，带 .sig）
UPDATE_PATTERNS: dict[str, tuple[str, ...]] = {
    "windows-x86_64": (".exe",),
    "darwin-aarch64": ("aarch64", ".app.tar.gz"),
}


def classify_update_asset(name: str) -> str | None:
    n = name.lower()
    if n.endswith(".sig"):
        return None
    if n.endswith(".exe"):
        return "windows-x86_64"
    if n.endswith(".app.tar.gz") and "aarch64" in n:
        return "darwin-aarch64"
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--artifacts", required=True, help="tauri 构建产物目录")
    ap.add_argument("--version", required=True, help="本次版本号，如 1.2.0")
    ap.add_argument("--base-url", required=True, help="服务端基址，如 https://papermatrix.online")
    ap.add_argument("--target", required=True, help="服务端分发目录（backend config 的 MATRIX_AGENT_DIST_DIR）")
    ap.add_argument("--notes", default="", help="更新说明，写入 latest.json 供客户端展示")
    args = ap.parse_args()

    artifacts = Path(args.artifacts).expanduser().resolve()
    target = Path(args.target).expanduser().resolve()
    version = args.version.lstrip("v")
    base = args.base_url.rstrip("/")

    if not artifacts.is_dir():
        print(f"[publish] 产物目录不存在：{artifacts}", file=sys.stderr)
        return 1

    version_dir = target / f"v{version}"
    version_dir.mkdir(parents=True, exist_ok=True)

    platforms: dict[str, dict[str, str]] = {}
    for asset in sorted(artifacts.iterdir()):
        if not asset.is_file():
            continue
        key = classify_update_asset(asset.name)
        if key is None:
            continue  # .dmg 首装包等不进 updater 清单，但仍拷贝进版本目录
        sig = asset.with_name(asset.name + ".sig")
        if not sig.is_file():
            print(f"[publish] 缺少签名文件 {sig.name}，跳过 {asset.name}", file=sys.stderr)
            continue
        platforms[key] = {
            "signature": sig.read_text(encoding="utf-8").strip(),
            "url": f"{base}/api/updates/matrix-agent/files/v{version}/{asset.name}",
        }

    if not platforms:
        print("[publish] 未发现任何带 .sig 的更新包产物，中止（latest.json 不写入）", file=sys.stderr)
        return 1

    manifest = {
        "version": version,
        "pub_date": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": args.notes,
        "platforms": platforms,
    }

    # 拷贝产物（含 .sig 与 .dmg，全量保留便于排查），覆盖同名旧文件
    for asset in artifacts.iterdir():
        if asset.is_file():
            shutil.copy2(asset, version_dir / asset.name)
    (target / "latest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"[publish] 版本 {version} 装配完成 -> {target}")
    for key, item in platforms.items():
        print(f"[publish]   {key}: {Path(item['url']).name}")
    missing = set(UPDATE_PATTERNS) - set(platforms)
    if missing:
        print(f"[publish] ⚠️ 缺平台产物：{sorted(missing)}（清单仍写入，缺失平台客户端不更新）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
