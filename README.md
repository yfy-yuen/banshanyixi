# 半山·一席 · 微信小程序点菜记账

私房菜馆「半山·一席」的微信小程序：顾客选包厢 → 点菜 → 下单；商家/店员登录后台管订单、菜品、订座、收款码。

## 技术架构（当前）

- **微信云开发**（环境 `cloud1-d9gs6p6t18e19cff9`），使用**文档数据库（NoSQL 集合）**，不是 PostgreSQL。
- 数据读写全部走**云函数中转**：前端 `utils/api.js` 统一调用云函数 `dataApi`（`wx.cloud.callFunction`），由云函数用 `wx-server-sdk` 访问集合。下单走独立的 `submitOrder` 云函数。
- 前端身份用 **CloudBase Auth**：顾客匿名登录（识别身份/角色），商家/店员账号密码登录。
- 角色（顾客 guest / 店员 clerk / 店长 manager）由 `staff` 集合控制，前端 `custom-tab-bar` 按角色渲染可见标签。

> ⚠️ 早期曾试过「独立腾讯云 CloudBase（yuen-cloud）+ PostgreSQL」方案，已废弃。本仓库**不使用** PostgreSQL / `app.rdb()` / 任何 PG 网关域名，一律以微信云开发文档库为准。

## 目录结构

```
restaurant-mini-mp/
├── app.js / app.json / app.wxss       # 入口、页面注册、全局样式、tabBar
├── project.config.json                # 工程配置（AppID、cloudfunctionRoot、关闭增强编译）
├── sitemap.json
├── package.json                       # 前端依赖 @cloudbase/js-sdk / @cloudbase/adapter-wx_mp
├── utils/
│   ├── config.js                      # ENV / ROOMS / OWNER_UID / CATS / 工具函数
│   ├── cloudbase.js                   # CloudBase Auth 初始化 + 错误归类（适配关闭增强编译）
│   ├── api.js                         # 统一经云函数 dataApi 的读写封装
│   └── runtime.js                     # regenerator-runtime（关闭增强编译后 async/await 必需）
├── cloudfunctions/
│   ├── dataApi/                       # 通用数据代理（约 20 个 action：读/写集合）
│   ├── submitOrder/                   # 提交包厢订单
│   └── initData/                      # 灌示例数据（5 菜 + 5 包厢），部署后测试一次
└── pages/
    ├── gate/     开门动画（首屏）
    ├── rooms/    包厢选择（首页 tab）
    ├── room/     单包厢内页（现场下单/订座）
    ├── menu/     点餐（菜单/规格/购物车/结算）
    ├── orders/   我的订单（按当前包厢）
    ├── book/     预定管理（商家）
    └── merchant/ 商家后台（登录 / 订单 / 菜品 / 收款码）
```

## 编译设置（重要）

- **必须保持「增强编译」关闭**：`project.config.json` 已设 `"enhance": false`。原因：微信开发者工具「增强编译」(Summer 编译器) 在部分版本会内部崩溃导致白屏；关闭后改用稳定版编译器即可规避。
- 为兼容「增强编译关闭」，源码使用 **CommonJS（`require` / `module.exports`）** 并内置 `utils/runtime.js` 提供 `async/await` 运行时——**不要**改回 `import/export`，也**不要**重新打开增强编译。
- 若 IDE「本地设置 → 增强编译」仍显示勾选，请手动取消（以 `project.config.json` 的 `enhance:false` 为准）。

## 运行步骤

### 1. 导入项目
微信开发者工具 → 导入项目 → 目录选 `C:\restaurant-mini-mp`：
- **AppID**：`wx4beadc7d17bba483`（已填，需更换自行修改）
- **后端服务**：选「**微信云开发**」（本项目用 `wx.cloud`，必须选此项）

### 2. 安装依赖并构建 npm
项目根目录执行 `npm install`，然后在微信开发者工具「工具 → 构建 npm」（首次必须）。构建成功会出现 `miniprogram_npm/`。

### 3. 云端一次性设置（详见 `操作步骤.md` 第四章）
在微信开发者工具「云开发」控制台：
1. 开启「匿名登录」与「账号密码登录」
2. 数据库新建集合：`dishes` `orders` `rooms` `bookings` `staff` `staff_requests` `payment_qrcodes`
3. 部署云函数 `dataApi` / `submitOrder` / `initData`（右键「上传并部署：云端安装依赖」）
4. 测试 `initData` 一次灌入示例数据
5. （看后台）在 `staff` 集合按账号 uid 登记 `role`

> 域名：本项目走 `wx.cloud`（云函数 + 云存储），均使用微信域名，**开发期无需配置 request 合法域名**；若本地报错，在「详情 → 本地设置」勾选「不校验合法域名」即可。

### 4. 预览 / 真机调试
「编译」在模拟器运行；「预览」扫码在手机真机调试。

## 依赖说明

- **前端**：`@cloudbase/js-sdk` + `@cloudbase/adapter-wx_mp`（仅用于 CloudBase Auth 匿名/密码登录；数据读写走云函数，不直接连数据库）。
- **云函数**：`wx-server-sdk`（访问文档数据库集合）。
- 锁定版本见 `package.json`，前端依赖**不要加 `^`**。

## 账号与权限

- **顾客**：进入即匿名登录，选包厢后点餐；订单按包厢号读写。
- **商家**：点「商家」tab 登录。
  - 老板 `boss` / `Boss8888` → 订单 / 菜品 / 预定 / 收款码 全部页签
  - 店员 `clerk` / `Clerk1234` → 仅 订单 / 菜品 2 个页签（无预定、无收款码）
- 角色由云端 `staff` 集合的 `role` 字段控制，前端只做显隐。登录账号需在「云开发 → 用户管理」创建，并在 `staff` 集合按该账号 uid 登记 `role`。

## 数据模型（集合）

| 集合 | 用途 |
|------|------|
| `dishes` | 菜品（name/category/price/image/description/specs/available） |
| `orders` | 订单（room_no/room_name/people/items/total/status/created_at） |
| `rooms` | 包厢（no/name，含 1/2/3/5/6，无 4 号） |
| `bookings` | 订座记录 |
| `staff` | 员工角色（openid/name/role，role=manager|clerk） |
| `staff_requests` | 员工开通申请 |
| `payment_qrcodes` | 收款码（channel/image_url） |

## 已知事项

- 菜品图：数据层已支持 `dishes.image`（存云存储 fileID），商家端可上传。
- 首次调用云函数有冷启动（2–8 秒），之后正常，属云开发正常现象。
