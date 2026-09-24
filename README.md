# Coding Access

给团队用的 AI 编程模型管理工具。

管理员在服务端配置供应商、API Key 和模型，成员通过桌面客户端登录、选择模型，在 Claude Code、Codex CLI、ChatGPT 桌面版或 ZCode 中使用。供应商密钥保存在服务端，每位成员使用独立的访问凭证。

[下载客户端](https://github.com/lgx1103/coding-access/releases/tag/client-v0.2.0-beta.14) · [部署服务端](docs/public/deployment.md) · [提交问题](https://github.com/lgx1103/coding-access/issues)

![工作台](docs/public/images/overview.png)

## 功能

- **管理模型和密钥**：接入多个供应商，为同一个模型配置不同来源，设置权重和并发数。
- **分配成员权限**：选择哪些模型对谁开放，随时调整权限或停用账号。
- **查看团队用量**：按日期、成员和模型统计 Token 用量，查看调用排行、请求明细，导出 CSV。
- **切换编程工具配置**：在客户端选择工具和模型，应用配置；支持工具检测、托盘、开机启动和应用内更新。

<details>
<summary>模型目录</summary>

![模型目录](docs/public/images/models.png)

</details>

<details>
<summary>用量统计</summary>

![用量统计](docs/public/images/usage.png)

</details>

## 安装与使用

项目由服务端和桌面客户端两部分组成，目前为 Beta 版本。先部署服务端，再让成员安装客户端。

| 下载 | 版本 | 安装方式 |
|---|---|---|
| [服务端](https://github.com/lgx1103/coding-access/releases/tag/server-v0.1.22) | 0.1.22 | Linux + Docker Compose，见[部署文档](docs/public/deployment.md) |
| [Windows x64](https://github.com/lgx1103/coding-access/releases/download/client-v0.2.0-beta.14/Coding-Access-0.2.0-beta.14-win-x64-setup.exe) | 0.2.0-beta.14 | 下载并运行 EXE |
| [macOS Apple Silicon](https://github.com/lgx1103/coding-access/releases/download/client-v0.2.0-beta.14/Coding-Access-0.2.0-beta.14-mac-arm64.zip) | 0.2.0-beta.14 | 解压后将 App 放入「应用程序」 |

服务端部署完成后，管理员添加供应商和密钥、发布模型，再创建成员账号。成员安装客户端，填写团队服务地址并登录，即可获取有权限使用的模型。编程工具需要自行安装。

服务端与客户端独立更新。其他版本、更新包及安装提示见 [Releases](https://github.com/lgx1103/coding-access/releases)，备份和升级步骤见[部署文档](docs/public/deployment.md)。

## 本地体验

准备 Node.js 22.16+（推荐 24）和 npm：

```sh
git clone https://github.com/lgx1103/coding-access.git
cd coding-access
npm ci
npm run build
npm run demo
```

打开 <http://127.0.0.1:4317>，使用 `admin` / `DemoAccess2026!` 登录。演示模式使用模拟模型响应，不需要 API Key。

## 开发与贡献

服务端使用 Node.js、Fastify 和 SQLite，界面使用 React，桌面端使用 Tauri。

欢迎提 Issue 或 PR。修改前可以先开一个 Issue，聊聊遇到的问题和打算怎么改。开发命令、测试要求见[贡献指南](CONTRIBUTING.md)。

- [部署、备份与升级](docs/public/deployment.md)
- [客户端构建与更新签名](docs/public/releases.md)
- [协议兼容与测试](docs/public/verification.md)
- [安全问题反馈](SECURITY.md)

## 关于作者

我是河南郑州的一个小程序员。这个项目起初是为了方便部门同事使用 AI 编程工具，后来决定开源出来。有问题或建议，欢迎提 Issue，也可以发邮件给我。

QQ 邮箱：[1373942050@qq.com](mailto:1373942050@qq.com)

## 许可证

[MIT](LICENSE)。第三方依赖见[许可声明](THIRD_PARTY_NOTICES.md)和 [Rust 依赖声明](src-tauri/THIRD_PARTY_RUST_NOTICES.txt)。项目中用于识别供应商的商标归各自所有者所有。
