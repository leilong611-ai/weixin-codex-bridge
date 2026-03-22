# 隐私与发布检查清单

这份仓库准备公开到 GitHub 之前，至少检查以下内容。

## 绝对不能提交的内容

- `.local/account.json`
- `.local/runtime.json`
- `.local/sync.json`
- `.local/bridge.log`
- `.local/login-qr.png`
- 任意调试二维码图片
- 带真实 `botToken` 的命令输出
- 带真实微信账号 ID 的截图或日志

## 必查项目

1. 运行 `npm run public-check`
2. 运行 `git diff --stat`
3. 手工检查 `README.md` 和 `docs/`
4. 确认示例路径都使用 `/path/to/...`
5. 确认没有真实 token、账号 ID、二维码 query

## 建议的发布前自查

```bash
git status --short
npm run public-check
```

## 人工决策项

这些不是技术问题，但发布前最好先定下来：

- 仓库名
- 是否公开
- 开源许可证
- 是否接受 issue / PR

## 推荐发布顺序

1. 在本地完成隐私检查
2. 新建空 GitHub 仓库
3. 首次提交只包含代码和文档
4. 推送后再次检查 GitHub 网页上的文件列表
5. 再决定是否补充截图、演示视频和 release
