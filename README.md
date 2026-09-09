# 点菜记账 · 微信小程序版

与已上线的 Web 版（CloudBase 静态托管）**共用同一套后端**：腾讯云开发环境 `yuen-cloud-d9g0mo1bv654d2ff6`（PostgreSQL 模式）、5 张表 + RLS 权限、匿名/密码登录模型完全一致。小程序端只是把前端从 HTML 改成 WXML/WXSS，数据层仍是 `app.rdb()`（Supabase 风格）。

> Web 版仍在线：https://yuen-cloud-d9g0mo1bv654d2ff6-1394617281.tcloudbaseapp.com/

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss       # 小程序入口、页面注册、全局样式、tabBar
├── project.config.json                # 工程配置（含占位 AppID、关闭域名校验）
├── sitemap.json
├── package.json                       # 依赖 @cloudbase/js-sdk / @cloudbase/adapter-wx_mp
├── utils/
│   ├── config.js                      # ENV / KEY / ROOMS / CATS / 工具函数
│   ├── cloudbase.js                   # SDK 初始化（wx_mp 适配器 + 匿名登录）
│   └── api.js                         # 云端读写（与 Web 版一致）
└── pages/
    ├── rooms/    包厢选择（首页 tab）
    ├── menu/     点餐（菜单/规格/购物车/结算）
    ├── orders/   我的订单（按当前包厢）
    └── merchant/ 商家后台（登录 / 订单 / 菜品 / 报表 / 收款码）
```

## 编译设置（重要）

- **必须关闭「增强编译」**：`project.config.json` 已设 `"enhance": false`。原因：微信开发者工具的「增强编译」(Summer 编译器) 在部分版本存在内部崩溃（`getDevCodeByFileList` 报错），会把页面整个拖垮、导致白屏。关闭后改用其稳定版编译器即可规避。
- 为兼容「增强编译关闭」，本项目源码已改写为 **CommonJS（`require` / `module.exports`）**，并内置 `utils/runtime.js`（regenerator-runtime）提供 `async/await` 运行时——因此**不要**再把 `import/export` 改回去，也不要重新打开增强编译。
- 若编译时 IDE 的「本地设置 → 增强编译」仍显示为勾选，请手动取消勾选（以 `project.config.json` 的 `enhance:false` 为准）。

## 运行步骤

### 1. 填 AppID（二选一）
- **已有 AppID**：`project.config.json` 的 `appid` 已填为 `wx632d1d9ad7cab2e4`（即你提供的真实 AppID），如需更换自行修改即可。
- **没有**：微信开发者工具里用「测试号」即可本地预览（功能不受影响，只是不能上传发布）。

> 申请 AppID：微信公众平台 mp.weixin.qq.com → 注册「小程序」→ 开发设置里复制 AppID。

### 2. 安装依赖并构建 npm
项目根目录（即本 `miniprogram/` 目录）执行：
```bash
npm install
```
然后在**微信开发者工具**里：`工具` → `构建 npm`（首次必须）。构建成功后 `miniprogram_npm/` 目录会出现。

> 若构建报错，多半是 Node 版本或缓存问题，可删除 `node_modules` 与 `miniprogram_npm` 重试。

### 3. 域名校验
`project.config.json` 已设 `"urlCheck": false`（开发期跳过 request 合法域名校验）。
正式发布前，需在 **小程序后台 → 开发 → 开发设置 → 服务器域名** 配置（地域 ap-shanghai）：
- `request 合法域名`：`https://tcb-api.tencentcloudapi.com` 、`https://yuen-cloud-d9g0mo1bv654d2ff6.service.tcloudbase.com`
- `uploadFile 合法域名`：`https://cos.ap-shanghai.myqcloud.com`
- `downloadFile 合法域名`：`https://yuen-cloud-d9g0mo1bv654d2ff6.tcb.qcloud.la` 、`https://cos.ap-shanghai.myqcloud.com`

（填域名不带 path；若与 CloudBase 控制台「环境配置 → 安全来源」显示的实际网关域名不一致，以控制台为准。）

### 4. 预览 / 真机调试
开发者工具里「编译」即可在模拟器运行；「预览」扫码可在手机上真机调试。

## 依赖版本说明（重要）
- 本项目锁定 `@cloudbase/js-sdk@3.8.0` 与 `@cloudbase/adapter-wx_mp@1.3.1`（见 `package.json`，**不要加 `^`**）。
- 网上有「v3 移除了 `useAdapters`、需降级到 2.27.3」的说法，但那是针对 NoSQL（文档型）数据库场景。本环境是 **PostgreSQL 模式**，必须用 v3 的 `app.rdb()`；已实测 v3.8.0 小程序端 `cloudbase.useAdapters(adapter)` 与 `app.rdb()` 均可用，且把 wx_mp 适配器作为内置依赖（`package.json` 的 `dependencies` 已含 `@cloudbase/adapter-wx_mp@^1.3.1`）。
- 在 Node 裸跑 SDK 会卡死（Node ESM 下 `getWxDefaultAdapter` 返回空的已知 bug），**不影响小程序**——小程序运行时有 `wx` 全局即可正常工作。

## 账号与权限（与 Web 版一致）

- **顾客**：进入即匿名登录，选包厢后点餐；订单按包厢号（`table_no`）读写。
- **商家**：点「商家」tab 登录。
  - 老板 `boss` / `Boss8888` → 订单 / 菜品 / 报表 / 收款码 4 个页签
  - 店员 `clerk` / `Clerk1234` → 仅 订单 / 菜品 2 个页签（无报表、无收款码）
- 角色由云端 `user_roles` 表控制，前端只做显隐。

## 包厢小程序码（可选）

让顾客扫码直接进对应包厢点餐，需生成**小程序码**，路径：
`pages/menu/menu?roomNo=1`（1/2/3/5 分别对应 谷山玥/满仓/枕山/云起）。
生成方式（任选）：
- 微信公众平台 → 该小程序的「二维码」入口（需已发布或体验版）；
- 服务端调用 `wxacode.getwxacodeunlimit`；
- CloudBase 若已开通小程序码能力，可在云端生成后托管到静态托管。
（拿到 AppID 并发布体验版后即可生成，暂无 AppID 时先用手动选包厢。）

## 已知事项
- 菜品图、收款码图片目前均为「粘贴公网 URL」。收款码浏览器直传云存储因 CloudBase PG 环境的 `storage.objects` 归平台所有、用户角色无法改写 RLS，暂未实现（与 Web 版相同限制）。
- 菜品规格在商家端「改价」时不编辑规格项（保留原 `specs`），仅改基础信息。
