# tiny-sql — 项目命令入口
# 使用 `just <command>` 运行；`just` 直接看全部命令
#
# Rust 是 workspace（ssh-multihop / db-driver / src-tauri），命令从根目录跑。

# .env 存在则加载（用于 integration 测试的 TINY_SQL_TEST_MYSQL_URL 等）
set dotenv-load := true

# 默认命令：显示帮助
default:
    @just --list

# === 开发 ===

# 启动 Tauri 开发模式（前端 + 后端热重载）
dev:
    pnpm tauri dev

# 仅启动 Next.js 前端开发服务器
dev-web:
    pnpm dev

# === 构建 ===

# 构建生产版本（Tauri 桌面应用，出 .dmg / .app）
build:
    pnpm tauri build

# 仅构建 Next.js 前端（静态导出到 out/）
build-web:
    pnpm build

# 构建 Debug 版本（含调试符号）
build-debug:
    pnpm tauri build --debug

# === 一键检查（对齐 CI：fmt 检查 + clippy + 测试 + 前端 build）===

# 提交前跑一遍，等价于 CI 的 check job
check: fmt-check lint-rust test-rust test-web build-web

# === 代码检查 ===

# 全部代码检查（前端类型 + 后端 clippy）
lint: lint-web lint-rust

# TypeScript 类型检查（v0.1 暂无 eslint，Week 2 配 shadcn 时再加）
lint-web:
    pnpm exec tsc --noEmit

# cargo clippy（整个 workspace，warning 即失败）
lint-rust:
    cargo clippy --workspace --all-targets -- -D warnings

# 格式化全部 Rust 代码
fmt:
    cargo fmt --all

# 仅检查格式不修改（CI 用）
fmt-check:
    cargo fmt --all --check

# === 测试 ===

# 全部单元测试（Rust + 前端）
test: test-rust test-web

# cargo test（workspace；不含连真实 MySQL 的 integration）
test-rust:
    cargo test --workspace

# 前端单元测试（vitest）
test-web:
    pnpm test

# integration 测试（连本地 MySQL，需 .env 设 TINY_SQL_TEST_MYSQL_URL，见 .env.example）
test-integration:
    cargo test -p db-driver -- --include-ignored

# === 依赖管理 ===

# 安装全部依赖（pnpm install + cargo fetch）
install:
    pnpm install
    cargo fetch

# 清理构建产物
clean:
    rm -rf out .next
    cargo clean

# === 版本 & 发布 ===

# 同步更新所有配置文件的版本号
[no-exit-message]
version bump:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "{{bump}}" ]; then
        echo "Usage: just version <new_version>"
        echo "Example: just version 0.2.0"
        exit 1
    fi
    VERSION="{{bump}}"
    echo "Updating version to $VERSION..."
    # package.json
    sed -i.bak "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json && rm package.json.bak
    # src-tauri/Cargo.toml（app 包版本；ssh-multihop / db-driver 独立版本不动）
    sed -i.bak "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml && rm src-tauri/Cargo.toml.bak
    # tauri.conf.json
    sed -i.bak "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json && rm src-tauri/tauri.conf.json.bak
    echo "✅ Version updated to $VERSION"

# 打包发布全流程（更新版本号、提交、推主干、打 Tag 触发云端构建）
[no-exit-message]
release tag:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "{{tag}}" ]; then
        echo "Usage: just release <tag>"
        echo "Example: just release v0.1.0"
        exit 1
    fi

    TAG="{{tag}}"
    # 剥离前缀 'v' 用于内部配置版本号
    VERSION="${TAG#v}"

    echo "🚀 开始基于版本 $TAG 构建发布流程..."

    echo "1️⃣ 更新配置文件版本号 ($VERSION) ..."
    just version "$VERSION"

    echo "2️⃣ 自动更新 CHANGELOG.md..."
    if [ -f CHANGELOG.md ] && grep -q '## \[Unreleased\]' CHANGELOG.md; then
        TODAY=$(date +%Y-%m-%d)
        perl -i -pe "s/## \\[Unreleased\\]/## \\[Unreleased\\]\\n\\n---\\n\\n## [$VERSION] — $TODAY/" CHANGELOG.md
        echo "   ✅ CHANGELOG 已更新: [Unreleased] -> [$VERSION] — $TODAY"
    else
        echo "   ⚠️ 无 CHANGELOG.md 或无 [Unreleased] 段，跳过"
    fi

    echo "3️⃣ 提交本次发布变更到 Git..."
    git add .
    git commit -m "🔖 release: $TAG" || echo "⚠️ 暂无变更需要提交，跳过 Commit"

    echo "4️⃣ 推送最新代码到当前远程分支..."
    git push origin HEAD

    echo "5️⃣ 创建并上传 $TAG 标签，触发云端构建流水线..."
    if git rev-parse "$TAG" >/dev/null 2>&1; then
        echo "⚠️ $TAG 标签已存在，跳过"
    else
        git tag -a "$TAG" -m "Release $TAG"
        git push origin "$TAG"
    fi

    echo "✅ 发布流程结束，去 GitHub Actions 看打包状态。"
