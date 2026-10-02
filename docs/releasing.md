# 发布 Release

本项目由 `.github/workflows/release.yml` 在推送 `v*` 标签时自动构建并发布：
Linux amd64/arm64、Windows amd64、macOS arm64，以及各平台 SHA-256 校验文件。

## 操作顺序

1. 确认代码、工作流修复及版本变更都已提交并推送到 `main`。
2. 在 `main` 上执行下面命令（以新的 `v2.0.1` 为例，不要覆盖已有标签）：

```bash
git switch main
git pull --ff-only
git tag -a v2.0.1 -m "Release v2.0.1"
git push origin v2.0.1
```

`git pull --ff-only` 拉取远端更新，但只允许本地分支快进，不会自动生成合并提交。
如果本地和远端各有自己的新提交，则报错停止，需要先解决分叉；不是强制覆盖本地代码。
本地与远端已一致时，这一步可省略。

3. 在 GitHub Actions 查看 `release` 流程；四个平台全部构建成功后，会自动创建 Release 并附加下载包。
4. 编辑发布说明，补充升级风险；本次必须说明迁移 019 删除旧原文不可逆，已解析资源保留，空间回收需要维护窗口执行 `VACUUM FULL`。

若希望程序包内部版本号同步更新，应在创建标签前修改 `Cargo.toml` 和 `frontend/package.json`，并更新/提交对应锁文件。
已推送的标签不会自动跟随后续提交；修改发布脚本后应使用包含该修改的新标签。
手动运行工作流时也必须选择 `v` 开头的标签，不能直接选择 `main`。

## 包格式与校验

- Linux/macOS 使用 `tar -czf`，是真正的 gzip 压缩文件，并在上传前检查 gzip 和 tar。
- Windows 使用 7-Zip 显式创建 ZIP，再执行 `7z t` 检查归档。
- 压缩包只包含 `pansou-api`、`frontend/dist` 和默认 `.env`；`.env` 由仓库 `.env.example` 模板生成，不读取本地私有 `.env`。
- `docker-compose.yml`、systemd 服务文件等部署辅助文件不进包，部署步骤见 README；SQLx 迁移本身已经编译进 Rust 程序。
- 优先使用 `sha256sum`，没有时回退到 `shasum -a 256`，上传前核验校验和。
- 缺少下载包或产物匹配失败会终止流程，不发布空下载列表。

本地运行样例回归测试，不编译实际程序：

```bash
node --test .github/tests/release-workflow.test.mjs
```

测试执行工作流中的实际 Bash 打包块，核对 gzip 文件头、文件清单、默认环境配置和校验和。
Windows ZIP 的本地测试只检查工作流契约，实际运行由 Windows CI 中的打包和归档校验完成。
