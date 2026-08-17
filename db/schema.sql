-- 半山·一席 小程序 · CloudBase PostgreSQL 建表脚本
-- 在 CloudBase 控制台「数据库 → PostgreSQL → 执行 SQL」中执行（或直接使用 db/init_cloud1.sql 一键版）。
-- 注意：staff.openid 字段实际存放的是小程序匿名登录得到的稳定 uid（身份标识）。
-- 字段约定以 yuen-cloud 真实 dishes 表 + 前端 menu.js/merchant.js 为准（description / specs / available）。

-- 包厢（各厢环境不同）
CREATE TABLE IF NOT EXISTS rooms (
  id        text PRIMARY KEY,          -- '1' / '2' / '3' / '5'（与 config.ROOMS 对应）
  name      text,
  env_photos text[],                   -- 本厢环境图 url
  restaurant_photos text[],            -- 餐厅公共照 url
  sort      int,
  status    int DEFAULT 1
);

-- 预定单（员工预售录入；棋牌占餐段）★room 内页「订单」tab 数据源
CREATE TABLE IF NOT EXISTS bookings (
  id          serial PRIMARY KEY,
  room_id     text REFERENCES rooms(id),
  date        date,                    -- 'YYYY-MM-DD'
  slot        text,                    -- 'lunch' | 'dinner'
  type        text,                    -- 'meal' | 'game'（棋牌占该餐段）
  dishes      jsonb,                   -- [{dish_id,name,image,qty,note}]
  guest_name  text,
  guest_phone text,
  note        text,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (room_id, date, slot)         -- 同厢同日期同餐段唯一
);

-- 到店点单（既有流程，menu 购物车提交）
CREATE TABLE IF NOT EXISTS orders (
  id         serial PRIMARY KEY,
  room_no    text,
  room_name  text,
  people     int,
  items      jsonb,
  total      numeric(10,2),
  status     text DEFAULT 'unpaid',    -- unpaid | paid
  paid_at    timestamptz,              -- 结账时间，dataApi.settleOrder 写入
  created_at timestamptz DEFAULT now()
);

-- 共用菜单（四厢同一份）
-- 字段以 yuen-cloud 真实 dishes 表为准，与前端 menu.js / merchant.js 约定一致：
--   name / category / price / image / description(描述) / specs(jsonb 规格) / available(上下架)
CREATE TABLE IF NOT EXISTS dishes (
  id          text PRIMARY KEY,        -- 业务串号，如 'd_hongshao'
  name        text NOT NULL,
  category    text,                    -- 热菜/凉菜/饮品/主食/其他
  price       numeric(10,2) NOT NULL,
  image       text,
  description text,
  specs       jsonb,                   -- 规格(份量/辣度等)，menu.js 读取
  available   boolean DEFAULT true,    -- 上下架，商家端维护
  created_at  timestamptz DEFAULT now()
);

-- 员工白名单（微信身份 RBAC）
CREATE TABLE IF NOT EXISTS staff (
  openid     text PRIMARY KEY,         -- 实际存匿名登录 uid
  name       text,
  role       text,                     -- 'clerk' | 'manager'
  invited_by text,
  created_at timestamptz DEFAULT now()
);

-- 员工入职待审
CREATE TABLE IF NOT EXISTS staff_requests (
  openid       text PRIMARY KEY,       -- 实际存匿名登录 uid
  name         text,
  status       text DEFAULT 'pending', -- pending | approved | rejected
  requested_at timestamptz DEFAULT now()
);

-- 收款码（微信/支付宝等，商家后台维护）→ merchant 收款码功能
CREATE TABLE IF NOT EXISTS payment_qrcodes (
  id         text PRIMARY KEY,         -- 'qr_' + 渠道标识，如 qr_wechat / qr_alipay
  channel    text,                     -- 'wechat' | 'alipay' | ...
  image_url  text,                     -- 收款码图片 url（或 base64）
  updated_at timestamptz DEFAULT now()
);

-- 初始店长（把你的 uid 填到下方，执行一次即可）：
-- INSERT INTO staff(openid, name, role) VALUES ('在此填你的uid', '店长', 'manager')
--   → 你的 uid 可在首次打开小程序后，于「商家」页无权限界面复制，或 Console 打印 globalData.uid。
