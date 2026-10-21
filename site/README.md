# LarkNotify 项目站

项目首页、使用入口和更新日志。纯静态输出，不连接飞书、管理后台或模型接口，不收集访客数据。

## 维护内容

- **公开版本**：根目录 `package.json` 的版本与 `CHANGELOG.md` 中有日期的条目。首页版本与更新页从这两处生成；`Unreleased` 不当作已发布版本。
- **开发进展**：`site/news.json`。新增一项时填入唯一 `id`、日期、标题、摘要和正文，`status` 固定为 `candidate`。功能正式发布后，更新旧进展的文字或移除过时说明，再写对应 CHANGELOG。
- **页面结构**：`site-build.cjs`。使用相对资源路径，适配 `/lark-codex-tasks/` 项目子目录。
- **样式与交互**：`site/assets/site.css`、`site/assets/site.js`。演示不触发真实操作；主要内容、链接和更新记录不依赖 JavaScript。
- **图片**：logo 来自项目已有 `docs/logo.png`；分享图为本站品牌文字与流程示意，不含真实聊天、任务或用户资料。

```sh
node --test site.test.cjs
node site-build.cjs
python3 -m http.server 8080 --directory _site
```

本地打开 `http://localhost:8080/`。输出 `_site/` 不提交。可通过 `node site-build.cjs --out <目录> --base https://example.com/project/` 指定输出和规范 URL。

## GitHub Pages

仓库 Settings → Pages → Build and deployment 的 Source 选择 **GitHub Actions**。首次启用需要仓库维护者权限；不能仅凭 workflow 文件就宣称网站已上线。

`.github/workflows/pages.yml` 在网站内容、版本或更新日志合入 main 时自动测试、构建并部署。PR 只构建验证，不部署；也可在 Actions 手动运行。仅上传 `_site`，不上传仓库源码、后台页面、配置或运行状态。

首页、更新页、Atom feed、sitemap、robots 和 404 页面都由同一次构建产生。默认站点地址为 `https://oldmanwalk.github.io/lark-codex-tasks/`；配置自定义域名时，应同步修改构建的 `--base` 参数。

## 与机器人版本发布的关系

网站可以独立更新，不需要重启机器人。机器人发布导出需把网站文件和工作流保留在白名单中，不能因网站是独立维护内容而把它误判为未知文件或覆盖删除。候选源码的 `release/site/` 和 `release/.github/workflows/` 保存对应发布源；同步维护后再运行发布预览。

网站发布只表示说明页面更新，不表示候选功能已部署到任何用户机器。平台支持、真实飞书验收和候选边界都应随版本如实写明。
