-- 半山·一席 · 在 yuen-cloud 环境补齐表结构（不破坏现有 dishes 真实数据）
-- 适用：yuen-cloud 当前已有 dishes(5道菜真实数据)、orders/payment_qrcodes/user_roles 为残缺占位表，
--       rooms/bookings/staff/staff_requests 不存在。
-- 策略：残缺表改名备份（保留遗留数据，不删除），再建正确结构；缺失表直接新建；dishes 完全不动。

-- 1) 残缺表改名备份（数据原封保留在 *_bak 中，符合"环境内容暂不动"）
ALTER TABLE orders RENAME TO orders_bak;
ALTER TABLE payment_qrcodes RENAME TO payment_qrcodes_bak;
ALTER TABLE user_roles RENAME TO user_roles_bak;

-- 2) 新建正确结构的表（字段以云函数 dataApi/submitOrder 实际 SQL 为准）
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
  room_id     text,
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

CREATE TABLE IF NOT EXISTS user_roles (
  uid        text PRIMARY KEY,
  role       text,
  created_at timestamptz DEFAULT now()
);

-- 3) 初始包厢数据（5 个，含 6 号知来）
INSERT INTO rooms (id, name, sort, status) VALUES
('1', '谷山玥', 1, 1),
('2', '满仓',   2, 1),
('3', '枕山',   3, 1),
('5', '云起',   5, 1),
('6', '知来',   6, 1)
ON CONFLICT (id) DO NOTHING;
