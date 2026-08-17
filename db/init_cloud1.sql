-- 半山·一席 小程序 · cloud1 一键初始化（建表 + 初始数据）
-- 用途：在 CloudBase 控制台 → cloud1 环境 → 数据库 → PostgreSQL → 执行 SQL 中一次性执行。
-- 表结构与 db/schema.sql 完全一致；菜品数据直接平移自 yuen-cloud 真实表（字段一致，无需改字段）。

-- ===== 建表 =====
CREATE TABLE IF NOT EXISTS rooms (
  id        text PRIMARY KEY,
  name      text,
  env_photos text[],
  restaurant_photos text[],
  sort      int,
  status    int DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id          serial PRIMARY KEY,
  room_id     text REFERENCES rooms(id),
  date        date,
  slot        text,
  type        text,
  dishes      jsonb,
  guest_name  text,
  guest_phone text,
  note        text,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (room_id, date, slot)
);

CREATE TABLE IF NOT EXISTS orders (
  id         serial PRIMARY KEY,
  room_no    text,
  room_name  text,
  people     int,
  items      jsonb,
  total      numeric(10,2),
  status     text DEFAULT 'unpaid',
  paid_at    timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dishes (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  category    text,
  price       numeric(10,2) NOT NULL,
  image       text,
  description text,
  specs       jsonb,
  available   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  openid     text PRIMARY KEY,
  name       text,
  role       text,
  invited_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_requests (
  openid       text PRIMARY KEY,
  name         text,
  status       text DEFAULT 'pending',
  requested_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_qrcodes (
  id         text PRIMARY KEY,
  channel    text,
  image_url  text,
  updated_at timestamptz DEFAULT now()
);

-- ===== 初始包厢（5 个，含 6 号知来）=====
INSERT INTO rooms (id, name, sort, status) VALUES
('1','谷山玥',1,1),
('2','满仓',2,1),
('3','枕山',3,1),
('5','云起',5,1),
('6','知来',6,1)
ON CONFLICT (id) DO NOTHING;

-- ===== 初始菜品（平移自 yuen-cloud 真实数据）=====
INSERT INTO dishes (id, name, category, price, image, description, specs, available) VALUES
('d_liangban','凉拌黄瓜','凉菜',12.00,'images/liangban_huanggua.svg','','[{"type": "multi", "group": "加料", "options": [{"delta": 2, "label": "加花生"}, {"delta": 3, "label": "加木耳"}]}]',true),
('d_kele','可乐','饮品',6.00,'images/kele.svg','','[]',true),
('d_qingchao','清炒时蔬','热菜',18.00,'images/qingchao_shushi.svg','','[]',true),
('d_mifan','米饭','主食',2.00,'images/mifan.svg','','[]',true),
('d_hongshao','红烧肉','热菜',38.00,'images/hongshao_rou.svg','招牌红烧肉','[{"type": "single", "group": "份量", "options": [{"delta": 0, "label": "小份"}, {"delta": 8, "label": "大份"}]}, {"type": "multi", "group": "辣度", "options": [{"delta": 0, "label": "微辣"}, {"delta": 0, "label": "特辣"}]}]',true)
ON CONFLICT (id) DO NOTHING;
