// 通用数据库代理云函数（cloud1 文档数据库版）
// 由 PostgreSQL 直连改为微信云开发文档数据库（NoSQL 集合），通过 wx-server-sdk 访问。
// 所有读写都走云函数（管理员权限），前端不直接连集合。
// 角色判定：用云函数上下文自动附带的稳定 OPENID 静默查 staff 集合，无需任何登录/弹窗。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 老板一次性注册解锁码（与 utils/config.js 的 BOSS_CODE 保持一致；此处内联避免跨端耦合）
const BOSS_CODE = 'Boss8888';

// 订阅消息模板 ID：云端 confirmReservation 发送侧读取。
// 优先用控制台云函数环境变量 RESERVE_TPL_ID（可在不改动代码的情况下覆盖），
// 若未配置则兜底用此常量，确保部署后推送开箱即用（两处 ID 必须与 MP 后台模板一致）。
const RESERVE_TPL_ID = 'kQPofhWMCtqHYs_DobSxURk0wvQF6k9o0_Rc0O-_uDE';
const tplId = process.env.RESERVE_TPL_ID || RESERVE_TPL_ID;

// 包厢编号（与 utils/config.js ROOMS 一致，无 4 号）；确认预订时用于自动分配空闲包厢
const ROOM_IDS = ['1', '2', '3', '5', '6'];
// 各包厢容量（用于自动分配「最小合适包厢」；与 ROOMS 顺序一致，按容量升序）
const ROOM_CAP = { '1': 4, '2': 6, '3': 8, '5': 10, '6': 14 };

// 把文档库返回的 _id 暴露为 id（前端代码统一用 .id 匹配）
function normalize(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => (r && r._id !== undefined ? { ...r, id: r._id } : r));
}

// 合并菜品列表：相同 dish_id/name 数量累加，保留原有字段
function mergeDishes(base, additions) {
  const map = {};
  (base || []).forEach((d) => {
    const key = d.dish_id || d.name;
    if (!key) return;
    if (!map[key]) map[key] = { ...d, qty: d.qty || 1 };
    else map[key].qty += (d.qty || 1);
  });
  (additions || []).forEach((d) => {
    const key = d.dish_id || d.name;
    if (!key) return;
    if (!map[key]) map[key] = { dish_id: d.dish_id || '', name: d.name, image: d.image || '', qty: d.qty || 1, note: d.note || '', sel: d.sel || '' };
    else map[key].qty += (d.qty || 1);
  });
  return Object.values(map);
}

// 预订系统辅助：集合自创建 / 手机号脱敏 / 开席时间
async function ensureCol(name) {
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
}
function maskPhone(s) {
  if (!s) return '';
  return String(s).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}
// 开席时间：优先用顾客填写的「预计到达时间」；否则回退午市 11:30 / 晚市 17:30。
function serveAtOf(date, mealTime, arrival) {
  const hm = (arrival && /^\d{1,2}:\d{2}$/.test(arrival)) ? arrival : (mealTime === 'dinner' ? '17:30' : '11:30');
  return new Date(date + 'T' + hm + ':00');
}
// 用餐时段（用于包厢日历分组）：预计到达 < 14:00 算午市，否则晚市
function slotOf(arrival) {
  if (arrival && /^\d{1,2}:\d{2}$/.test(arrival)) {
    const h = parseInt(arrival.split(':')[0], 10);
    return h < 14 ? 'lunch' : 'dinner';
  }
  return '';
}
// 分厢冲突窗口（结论 #8）：占用窗口 = [到达, 到达+4h]；同日内到达时间差 < 4h 即视为冲突。
function overlapWithin(aDate, aArr, bDate, bArr) {
  if (aDate !== bDate) return false;
  const pa = serveAtOf(aDate, '', aArr).getTime();
  const pb = serveAtOf(bDate, '', bArr).getTime();
  return Math.abs(pa - pb) < 4 * 3600 * 1000;
}
// 自动分配最小合适包厢（结论 #H）：容量 ≥ 人数 且 当日该窗口空闲；无合适则返回 ''
async function pickFreeRoom(date, arrival, partySize) {
  const slot = slotOf(arrival) || 'lunch';
  const occ = (await db.collection('bookings').where({ date, slot }).limit(1000).get()).data || [];
  const used = new Set();
  occ.forEach((b) => { if (overlapWithin(date, b.arrival || '', date, arrival)) used.add(String(b.room_id)); });
  for (const no of ROOM_IDS) {
    if (used.has(no)) continue;
    if ((ROOM_CAP[no] || 99) >= partySize) return no; // ROOM_IDS 已按容量升序
  }
  return '';
}
function tsOf(v) {
  if (!v) return 0;
  if (v.getTime) return v.getTime();
  if (v.$date) return new Date(v.$date).getTime();
  return new Date(v).getTime();
}

// 定时触发器入口：每日自动执行「清过期申请 / 发到店提醒 / 清零售罄限定」。
// 注意：定时触发时云函数上下文无 OPENID，无法走 staff 权限校验，故直接以云函数管理员身份执行。
async function runDailyCron() {
  let cancelled = 0;
  let sent = 0;
  let reset = 0;

  // 1. 清理超过 24h 的 pending 预订
  try {
    await ensureCol('reservations');
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const list = (await db.collection('reservations').where({ status: 'pending' }).limit(1000).get()).data || [];
    for (const r of list) {
      if (tsOf(r.createdAt) && tsOf(r.createdAt) < cutoff) {
        try {
          await db.collection('reservations').doc(r._id).update({ data: { status: 'cancelled' } });
          cancelled++;
        } catch (e) { console.warn('[cron sweep]', e.message); }
      }
    }
  } catch (e) { console.warn('[cron sweep outer]', e.message); }

  // 2. 到店双发提醒（提前 1 天 + 提前 2 小时）
  try {
    await ensureCol('reservations');
    const now = Date.now();
    const list = (await db.collection('reservations').where({ status: 'confirmed' }).limit(1000).get()).data || [];
    for (const r of list) {
      const serve = serveAtOf(r.date, r.mealTime, r.expectedArrival).getTime();
      const dayBefore = serve - 24 * 3600 * 1000;
      const twoHour = serve - 2 * 3600 * 1000;
      let which = '';
      if (!r.reminded1 && now >= dayBefore && now <= dayBefore + 24 * 3600 * 1000) which = 'reminded1';
      else if (!r.reminded2 && now >= twoHour && now <= twoHour + 6 * 3600 * 1000) which = 'reminded2';
      if (which && tplId) {
        try {
          await cloud.openapi.subscribeMessage.send({
            touser: r._openid,
            templateId: tplId,
            data: {
              date1: { value: String(r.date || '') },
              number2: { value: Number(r.partySize) || 0 },
              thing3: { value: '半山一席私宴' },
              thing4: { value: r.roomNo ? r.roomNo + ' 号包厢' : '敬请期待' },
            },
          });
          await db.collection('reservations').doc(r._id).update({ data: { [which]: true } });
          sent++;
        } catch (e) { console.warn('[cron remind]', e.message); }
      }
    }
  } catch (e) { console.warn('[cron remind outer]', e.message); }

  // 3. 每日开门清零售罄/限定标记
  try {
    const list = (await db.collection('dishes').limit(1000).get()).data || [];
    const flagged = list.filter((d) => d.soldOut || d.limited);
    for (const d of flagged) {
      try {
        await db.collection('dishes').doc(d._id).update({ data: { soldOut: false, limited: false } });
        reset++;
      } catch (e) { console.warn('[cron reset]', e.message); }
    }
  } catch (e) { console.warn('[cron reset outer]', e.message); }

  return { data: { cron: true, cancelled, sent, reset } };
}

exports.main = async (event) => {
  // 定时触发器入口（无 action，以 TriggerName 识别）
  if (event && event.TriggerName) {
    return await runDailyCron();
  }
  const { action, ...p } = event || {};
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  // 当前用户角色：基于微信 OPENID 静默判定（OPENID 在云函数上下文自动可用，无需登录）
  const roleOf = async () => {
    if (!openid) return 'guest';
    try {
      const r = await db.collection('staff').where({ openid }).field({ role: true }).limit(1).get();
      return (r.data && r.data[0] && r.data[0].role) || 'guest';
    } catch (e) { return 'guest'; }
  };
  const isStaffOf = async () => {
    const r = await roleOf();
    return r === 'clerk' || r === 'manager';
  };

  try {
    let rows;
    switch (action) {
      /* ===== 身份（静默，无登录框） ===== */
      case 'whoami': {
        const role = await roleOf();
        return { data: { openid, role } };
      }
      case 'bindBoss': {
        if (!openid) return { error: '身份未就绪' };
        if (p.code !== BOSS_CODE) return { error: '解锁码错误' };
        const role = await roleOf();
        if (role === 'manager') return { data: { openid, role: 'manager', already: true } };
        await db.collection('staff').add({ data: { openid, name: '店长', role: 'manager', created_at: db.serverDate() } });
        return { data: { openid, role: 'manager' } };
      }
      // 一次性老板身份采集通道：当前微信身份（openid）首次上报到 owner_boot 集合，
      // 由管理员（AI/店主）从云端读取后显式写入 staff(manager)，写完即删集合，不自动赋权。
      case 'ownerBoot': {
        if (!openid) return { error: '身份未就绪' };
        try { await db.createCollection('owner_boot'); } catch (e) { /* 已存在则忽略 */ }
        const ex = await db.collection('owner_boot').where({ openid }).limit(1).get();
        if (!ex.data || !ex.data.length) {
          await db.collection('owner_boot').add({ data: { openid, t: db.serverDate() } });
        }
        return { data: { ok: true } };
      }

      /* ===== 公开读（顾客点菜，客户端再按 available 过滤下架） ===== */
      case 'dishes':
        rows = normalize((await db.collection('dishes').orderBy('price', 'asc').limit(1000).get()).data);
        break;

      /* ===== 读（店员/老板） ===== */
      case 'ordersByRoom':
        rows = normalize((await db.collection('orders').where({ room_no: p.roomNo }).orderBy('created_at', 'desc').limit(1000).get()).data);
        break;
      case 'ordersByRoomName':
        rows = normalize((await db.collection('orders').where({ room_name: p.roomName }).orderBy('created_at', 'desc').limit(1000).get()).data);
        break;
      case 'rooms':
        rows = normalize((await db.collection('rooms').limit(1000).get()).data);
        break;
      case 'bookings':
        if (p.date) rows = normalize((await db.collection('bookings').where({ date: p.date }).limit(1000).get()).data);
        else if (p.month) {
          // 按月份查询整月 booking（供店务日历聚合每日已订包厢数）
          const ym = String(p.month);
          const first = ym + '-01';
          const lastDay = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
          const last = `${ym}-${lastDay < 10 ? '0' + lastDay : lastDay}`;
          rows = normalize((await db.collection('bookings').where({ date: _.gte(first).and(_.lte(last)) }).limit(1000).get()).data);
        }
        else rows = normalize((await db.collection('bookings').limit(1000).get()).data);
        break;
      case 'bookingCountsByMonth': {
        // 返回当月每一天已排包厢数量（按 bookings 集合 date 字段统计），供店务日历显示小角标
        const ym = String(p.yearMonth || '');
        if (!/^\d{4}-\d{2}$/.test(ym)) return { error: 'yearMonth 格式需为 YYYY-MM' };
        const first = ym + '-01';
        const lastDay = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
        const last = `${ym}-${lastDay < 10 ? '0' + lastDay : lastDay}`;
        const all = (await db.collection('bookings').where({ date: _.gte(first).and(_.lte(last)) }).limit(1000).get()).data || [];
        const counts = {};
        all.forEach((b) => { if (b.date) counts[b.date] = (counts[b.date] || 0) + 1; });
        return { data: counts };
      }

      /* ===== 读（店员/老板：订单列表） ===== */
      case 'merchantOrders': {
        if (!(await isStaffOf())) return { error: '无权限' };
        rows = normalize((await db.collection('orders').orderBy('created_at', 'desc').limit(1000).get()).data);
        break;
      }

      /* ===== 读（老板专属） ===== */
      case 'dishesAdmin': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        rows = normalize((await db.collection('dishes').orderBy('price', 'asc').limit(1000).get()).data);
        break;
      }
      case 'paymentQrcodes': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        rows = normalize((await db.collection('payment_qrcodes').limit(1000).get()).data);
        break;
      }
      case 'staff': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        rows = normalize((await db.collection('staff').where({ openid: p.openid }).limit(1).get()).data);
        break;
      }
      case 'staffRequests': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        rows = normalize((await db.collection('staff_requests').where({ status: p.status || 'pending' }).limit(1000).get()).data);
        break;
      }

      /* ===== 写（店员/老板：标记支付，记录支付方式 结论 #7） ===== */
      case 'settleOrder': {
        if (!(await isStaffOf())) return { error: '无权限' };
        const pm = (p.paymentMethod === 'scan' || p.paymentMethod === 'credit') ? p.paymentMethod : 'cash';
        await db.collection('orders').doc(p.id).update({ data: { status: 'paid', paymentMethod: pm, paid_at: db.serverDate() } });
        return { data: { ok: true, paymentMethod: pm } };
      }

      /* ===== 写（店员/老板：结账清台，一步完成支付+关单归档+生成电子收据 结论 #E/#6） ===== */
      case 'clearOrder': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('receipts');
        const order = (await db.collection('orders').doc(p.id).get()).data;
        if (!order) return { error: '订单不存在' };
        // 结账时若传入支付方式则覆盖（前端「结账」按钮选现金/扫码/记账后一步到位），解决两步法口径分裂
        const pm = (p.paymentMethod === 'scan' || p.paymentMethod === 'credit') ? p.paymentMethod : (order.paymentMethod || 'cash');
        // 收据明细：以订单实际下单菜品为准（含规格/单价/小计）
        const items = order.items || [];
        let total = 0;
        const lines = items.map((it) => {
          const unit = (it.unitPrice != null) ? Number(it.unitPrice) : 0;
          const qty = Number(it.qty) || 1;
          total += unit * qty;
          return { name: it.name, qty, unitPrice: unit, sel: it.selText || '', subtotal: unit * qty };
        });
        // 客人手机后 4 位（best-effort：按包厢+当日关联 booking 的 guest_phone）
        let phoneLast4 = '';
        try {
          const odate = String(order.created_at || '').slice(0, 10);
          const bks = (await db.collection('bookings').where({ room_id: String(order.room_no), date: odate }).limit(5).get()).data || [];
          const ph = (bks[0] && bks[0].guest_phone) || '';
          if (/^\d{11}$/.test(ph)) phoneLast4 = ph.slice(7);
        } catch (e) { console.warn('[receipt] phone', e.message); }
        const now = new Date();
        const receipt = {
          no: 'R' + now.getTime(),
          order_id: order._id,
          room_no: order.room_no, room_name: order.room_name || '',
          date: String(order.created_at || '').slice(0, 10),
          time: now.toISOString().slice(11, 19),
          phoneLast4,
          items: lines, total,
          paymentMethod: pm,
          paid: true,
          invoiced: false,
          note: order.note || '',
          created_at: db.serverDate(),
        };
        await db.collection('receipts').add({ data: receipt });
        await db.collection('orders').doc(p.id).update({
          data: { status: 'paid', paymentMethod: pm, closed: true, closed_at: db.serverDate(), receipt_no: receipt.no },
        });
        return { data: { ok: true, receiptNo: receipt.no } };
      }

      /* ===== 写（老板专属：菜品改价/改内容、收款码、员工审批） ===== */
      case 'saveDish': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        const d = p.payload || {};
        const avail = d.available !== false;
        const data = {
          name: d.name, category: d.category, price: Number(d.price),
          image: d.image || '', description: d.description || '',
          specs: d.specs || [], available: avail,
          soldOut: !!d.soldOut, limited: !!d.limited,
          portions: d.portions || {}, // 每份用量字典 {材料: 数值}，供食材采购清单反算（结论 #D）
        };
        if (p.id === '__new__') {
          const _id = (await db.collection('dishes').add({ data: { ...data, created_at: db.serverDate() } }))._id;
          rows = [{ _id }];
        } else {
          await db.collection('dishes').doc(p.id).update({ data });
          rows = [{ _id: p.id }];
        }
        break;
      }
      case 'deleteDish': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await db.collection('dishes').doc(p.id).remove();
        return { data: { ok: true } };
      }
      case 'saveQr': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await db.collection('payment_qrcodes').doc('qr_' + p.ch).set({
          data: { channel: p.ch, image_url: p.url, updated_at: db.serverDate() },
        });
        return { data: { ok: true } };
      }
      /* ===== 包厢内容（老板专属）：环境照 + 富文本介绍 ===== */
      case 'roomGet': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        const list = (await db.collection('rooms').where({ room_no: p.roomNo }).limit(1).get()).data;
        rows = normalize(list);
        break;
      }
      case 'saveRoom': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        // 仅收 cloud:// 文件ID，杜绝把临时 https 链写库（临时链会过期导致图片失效）
        const envPhotos = Array.isArray(p.envPhotos)
          ? p.envPhotos.filter((x) => x && x.indexOf('cloud://') === 0)
          : [];
        const intro = typeof p.intro === 'string' ? p.intro : '';
        const cover = envPhotos[0] || '';
        const existing = (await db.collection('rooms').where({ room_no: p.roomNo }).limit(1).get()).data;
        if (existing && existing.length) {
          await db.collection('rooms').doc(existing[0]._id).update({
            data: { env_photos: envPhotos, intro, cover, updated_at: db.serverDate() },
          });
        } else {
          await db.collection('rooms').add({
            data: { room_no: p.roomNo, env_photos: envPhotos, restaurant_photos: [], intro, cover, created_at: db.serverDate() },
          });
        }
        return { data: { ok: true } };
      }
      case 'saveBooking': {
        if (!(await isStaffOf())) return { error: '无权限' };
        const b = p.booking || {};
        const data = {
          room_id: b.room_id, date: b.date, slot: b.slot, type: b.type,
          dishes: b.dishes, guest_name: b.guest_name, guest_phone: b.guest_phone, note: b.note,
          partySize: Number(b.partySize) || 0,
        };
        if (p.id) {
          await db.collection('bookings').doc(p.id).update({ data });
        } else {
          const _id = (await db.collection('bookings').add({ data }))._id;
          rows = [{ _id }];
        }
        break;
      }
      case 'deleteBooking':
        await db.collection('bookings').doc(p.id).remove();
        return { data: { ok: true } };
      // 店员/老板：在排席详情弹窗直接追加菜品（同步回写关联 reservation，保证顾客端一致）
      case 'appendBookingDishes': {
        if (!(await isStaffOf())) return { error: '无权限' };
        const b = (await db.collection('bookings').doc(p.id).get()).data;
        if (!b) return { error: '排席不存在' };
        const additions = Array.isArray(p.dishes) ? p.dishes : [];
        if (!additions.length) return { error: '未选择菜品' };
        const merged = mergeDishes(b.dishes, additions);
        await db.collection('bookings').doc(p.id).update({ data: { dishes: merged } });
        if (b.reservationRef) {
          try {
            const r = (await db.collection('reservations').doc(b.reservationRef).get()).data;
            if (r) {
              const resMerged = mergeDishes(r.dishes, additions);
              await db.collection('reservations').doc(b.reservationRef).update({ data: { dishes: resMerged } });
            }
          } catch (e) { console.warn('[appendBookingDishes] sync reservation', e.message); }
        }
        return { data: { ok: true, count: additions.length } };
      }
      case 'approveStaff': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await db.collection('staff').add({ data: { openid: p.openid, name: p.name, role: p.role, invited_by: openid } });
        await db.collection('staff_requests').where({ openid: p.openid }).update({ data: { status: 'approved' } });
        return { data: { ok: true } };
      }
      case 'removeStaff': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await db.collection('staff').where({ openid: p.openid }).remove();
        return { data: { ok: true } };
      }
      case 'requestStaff':
        await db.collection('staff_requests').add({ data: { openid, name: p.name, status: 'pending' } });
        return { data: { ok: true } };

      /* ===== 预订系统：场次 sessions + 预订申请 reservations（申请制 / 隐藏库存） ===== */
      // 顾客：开放场次列表（仅 open；用 bookable 暴露可订/已满，绝不返回 capacity/reservedSeats）
      case 'listSessions': {
        await ensureCol('sessions'); await ensureCol('reservations');
        const list = (await db.collection('sessions').where({ status: 'open' }).orderBy('date', 'asc').orderBy('mealTime', 'asc').limit(1000).get()).data;
        rows = list.map((s) => {
          const remain = (s.capacity || 0) - (s.reservedSeats || 0);
          return {
            id: s._id, date: s.date, mealTime: s.mealTime, note: s.note || '',
            bookable: remain > 0, full: remain <= 0, menuCount: (s.menuSnapshot || []).length,
          };
        });
        break;
      }
      // 顾客：场次详情（菜单快照只读；bookable 不暴露余位）
      case 'sessionDetail': {
        await ensureCol('sessions');
        const s = (await db.collection('sessions').doc(p.id).get()).data;
        if (!s) return { error: '场次不存在' };
        const remain = (s.capacity || 0) - (s.reservedSeats || 0);
        rows = {
          id: s._id, date: s.date, mealTime: s.mealTime, note: s.note || '',
          bookable: remain > 0, full: remain <= 0, menu: s.menuSnapshot || [],
        };
        break;
      }
      // 顾客：提交订位申请（不再依赖场次，自带 date/expectedArrival；店务确认时自动排席）
      case 'submitReservation': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('reservations');
        const ps = Number(p.partySize);
        if (!ps || ps < 1) return { error: '请填写有效人数' };
        if (!/^1[3-9]\d{9}$/.test(p.contactPhone || '')) return { error: '请填写正确的 11 位手机号' };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return { error: '请选择日期' };
        // 时间口径（结论 #G）：顾客填「预计到达时间」，推导 mealTime/slot，不再二选一午晚市
        const arrival = (p.expectedArrival && /^\d{1,2}:\d{2}$/.test(p.expectedArrival)) ? p.expectedArrival : '';
        const mealTime = p.mealTime === 'dinner' ? 'dinner' : (p.mealTime === 'lunch' ? 'lunch' : (slotOf(arrival) || 'lunch'));
        const slot = slotOf(arrival) || mealTime;
        // 自动预匹配建议包厢（结论 #H/#10）：顾客若未指定包厢，则按容量≥人数且当日该窗口空闲挑最小合适厢，
        // 作为「建议包厢」写入 roomNo，供店员审批时直接看到；若顾客已指定则尊重其选择。
        let suggestRoom = p.roomNo || '';
        if (!suggestRoom) {
          try { suggestRoom = await pickFreeRoom(p.date, arrival, ps) || ''; } catch (e) { console.warn('[submit] suggest', e.message); }
        }
        const _id = (await db.collection('reservations').add({
          data: {
            _openid: openid, date: p.date, mealTime, slot, expectedArrival: arrival, roomNo: suggestRoom,
            partySize: ps, contactPhone: p.contactPhone, note: p.note || '',
            dishes: Array.isArray(p.dishes) ? p.dishes : [],
            status: 'pending', source: 'self', createdAt: db.serverDate(),
          },
        }))._id;
        return { data: { id: _id, status: 'pending', suggestRoom } };
      }
      // 顾客：我的预订（自身）；自带 date/mealTime，roomId 由 reservationRef 关联 booking
      case 'myReservations': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('reservations'); await ensureCol('bookings');
        const list = (await db.collection('reservations').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(1000).get()).data;
        const ids = list.map((r) => r._id);
        const bks = ids.length ? (await db.collection('bookings').where({ reservationRef: _.in(ids) }).limit(1000).get()).data : [];
        const bkMap = {};
        bks.forEach((b) => { if (!bkMap[b.reservationRef]) bkMap[b.reservationRef] = b.room_id; });
        rows = list.map((r) => ({
          id: r._id, date: r.date, mealTime: r.mealTime, slot: r.slot || '', expectedArrival: r.expectedArrival || '', roomNo: r.roomNo || '',
          partySize: r.partySize, contactPhone: maskPhone(r.contactPhone), note: r.note || '',
          status: r.status, source: r.source, createdAt: r.createdAt,
          rejectReason: r.rejectReason || '', arrivedAt: r.arrivedAt || '',
          roomId: bkMap[r._id] || null,
          dishes: r.dishes || [],
        }));
        break;
      }
      // 顾客：取消（仅 pending/confirmed，且距开席 > 4h；释放包厢排席 + 预点菜一并作废）
      case 'cancelReservation': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('reservations'); await ensureCol('bookings');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r || r._openid !== openid) return { error: '无权限' };
        if (r.status !== 'pending' && r.status !== 'confirmed' && r.status !== 'pending_manual') return { error: '当前状态不可取消' };
        const serve = serveAtOf(r.date, r.mealTime, r.expectedArrival);
        if (serve && (serve.getTime() - Date.now()) < 4 * 3600 * 1000) return { error: '距开席不足 4 小时，无法自助取消' };
        // 结论 #6：取消时预点菜一并作废（释放包厢占用），避免脏数据
        await db.collection('reservations').doc(p.id).update({ data: { status: 'cancelled', dishes: [] } });
        // 同步释放关联的包厢排席（确认时自动生成的 booking）
        try {
          const linked = (await db.collection('bookings').where({ reservationRef: p.id }).limit(10).get()).data || [];
          for (const b of linked) { try { await db.collection('bookings').doc(b._id).remove(); } catch (e) {} }
        } catch (e) { console.warn('[cancel] booking', e.message); }
        return { data: { ok: true } };
      }

      // 顾客：保存/修改预点菜（仅待确认可改；与订位解耦，不影响包厢排席）
      case 'savePreorder': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('reservations');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r || r._openid !== openid) return { error: '无权限' };
        if (r.status !== 'pending') return { error: '仅待确认时可预点或修改' };
        const dishes = Array.isArray(p.dishes) ? p.dishes : [];
        await db.collection('reservations').doc(p.id).update({ data: { dishes } });
        return { data: { ok: true } };
      }
      // 顾客：读取单条预订（含预点菜），供预点菜页回显
      case 'getReservation': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('reservations');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r || r._openid !== openid) return { error: '无权限' };
        return { data: { id: r._id, date: r.date, mealTime: r.mealTime, slot: r.slot || '', expectedArrival: r.expectedArrival || '', partySize: r.partySize, contactPhone: maskPhone(r.contactPhone), note: r.note || '', status: r.status, rejectReason: r.rejectReason || '', dishes: r.dishes || [] } };
      }

      /* ===== 以下为店员/老板 ===== */
      // 老板/店员：发布场次（快照当前在售菜品为当天菜单）
      case 'publishSession': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('sessions');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return { error: '日期格式错误' };
        const cap = Number(p.capacity);
        if (!cap || cap < 1) return { error: '请填写有效座位上限' };
        const mt = p.mealTime === 'dinner' ? 'dinner' : 'lunch';
        const dishes = (await db.collection('dishes').where({ available: _.neq(false) }).limit(1000).get()).data || [];
        const menuSnapshot = dishes.map((d) => ({ name: d.name, image: d.image || '', desc: d.description || '', category: d.category || '', price: d.price }));
        const _id = (await db.collection('sessions').add({
          data: {
            date: p.date, mealTime: mt, roomRef: p.roomRef || '', capacity: cap, reservedSeats: 0,
            status: 'open', note: p.note || '', menuSnapshot, serveAt: serveAtOf(p.date, mt), createdAt: db.serverDate(),
          },
        }))._id;
        return { data: { id: _id } };
      }
      // 老板/店员：全部预订（自带 date/mealTime，列表脱敏；明文仅老板可见）
      case 'listReservations': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('reservations');
        const isMgr = (await roleOf()) === 'manager';
        const list = (await db.collection('reservations').orderBy('createdAt', 'desc').limit(1000).get()).data;
        rows = list.map((r) => ({
          id: r._id, date: r.date, mealTime: r.mealTime, slot: r.slot || '', expectedArrival: r.expectedArrival || '', roomNo: r.roomNo || '',
          partySize: r.partySize, contactPhone: maskPhone(r.contactPhone), phonePlain: isMgr ? (r.contactPhone || '') : '',
          note: r.note || '', status: r.status, source: r.source, createdAt: r.createdAt,
          rejectReason: r.rejectReason || '', dishes: r.dishes || [],
        }));
        break;
      }
      // 老板/店员：确认（翻转状态 + 自动在 bookings 生成一桌，打通订位与包厢排席）
      case 'confirmReservation': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('reservations'); await ensureCol('bookings');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r) return { error: '预订不存在' };
        if (r.status !== 'pending') return { error: '仅待确认可确认' };
        const slot = r.slot || slotOf(r.expectedArrival) || (r.mealTime === 'dinner' ? 'dinner' : 'lunch');

        // 分配包厢（结论 #H/#8/#10）：
        // 1) 商家审核时可手动指定 roomId（覆盖），需校验该窗口空闲；
        // 2) 否则自动分配「最小合适包厢」（容量≥人数 且 当日窗口空闲）；
        // 3) 无合适厢 → 标记 pending_manual（待人工分配），不自动婉拒。
        let roomId = (p.roomId && String(p.roomId)) || r.roomNo || '';
        if (roomId) {
          const clash = (await db.collection('bookings').where({ date: r.date, slot, room_id: roomId }).limit(1).get()).data || [];
          if (clash.some((b) => overlapWithin(r.date, b.arrival || '', r.date, r.expectedArrival || ''))) roomId = '';
        }
        if (!roomId) {
          try { roomId = await pickFreeRoom(r.date, r.expectedArrival || '', r.partySize); } catch (e) { console.warn('[confirm] alloc', e.message); }
        }

        // 满厢：转人工分配（结论 #10），不翻转 confirmed
        if (!roomId) {
          await db.collection('reservations').doc(p.id).update({ data: { status: 'pending_manual', manualAt: db.serverDate() } });
          return { data: { ok: true, bookingId: '', roomId: '', needManualAssign: true } };
        }

        await db.collection('reservations').doc(p.id).update({ data: { status: 'confirmed', confirmedAt: db.serverDate(), roomNo: roomId } });

        let bookingId = '';
        {
          // 优先用顾客预点的 dishes；否则用当前在售菜品快照兜底（保持「订餐菜品」有内容）
          let dishSnapshot;
          if (Array.isArray(r.dishes) && r.dishes.length) {
            dishSnapshot = r.dishes.map((d) => ({ dish_id: d.dish_id, name: d.name, image: d.image || '', qty: d.qty || 1, note: d.note || '', sel: d.sel || '' }));
          } else {
            const dishes = (await db.collection('dishes').where({ available: _.neq(false) }).limit(1000).get()).data || [];
            dishSnapshot = dishes.map((d) => ({ dish_id: d._id, name: d.name, image: d.image || '', qty: 1, note: '', sel: '' }));
          }
          bookingId = (await db.collection('bookings').add({
            data: {
              room_id: roomId, date: r.date, slot, type: 'meal', arrival: r.expectedArrival || '',
              dishes: dishSnapshot, guest_name: '', guest_phone: r.contactPhone || '', note: r.note || '',
              partySize: Number(r.partySize) || 0,
              reservationRef: r._id, source: 'reservation', created_at: db.serverDate(),
            },
          }))._id;
        }

        // 订阅消息通知顾客（结论 #3/#21：确认即发「预订成功」推送；到店前提醒由定时任务 pushReminders 补发）
        try {
          if (tplId) {
            await cloud.openapi.subscribeMessage.send({
              touser: r._openid,
              templateId: tplId,
              data: {
                date1: { value: String(r.date || '') },
                number2: { value: Number(r.partySize) || 0 },
                thing3: { value: '半山一席私宴' },
                thing4: { value: roomId ? roomId + '号包厢' : '待安排' },
              },
            });
          }
        } catch (e) { console.warn('[subscribe]', e.message); }

        return { data: { ok: true, bookingId, roomId, needManualAssign: false } };
      }
      // 老板/店员：婉拒（结论 #4：优先自动换厢重排；无可用厢才仅附文字原因婉拒）
      case 'rejectReservation': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('reservations'); await ensureCol('bookings');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r) return { error: '预订不存在' };
        if (r.status !== 'pending' && r.status !== 'pending_manual') return { error: '仅待确认可婉拒' };
        const slot = r.slot || slotOf(r.expectedArrival) || (r.mealTime === 'dinner' ? 'dinner' : 'lunch');

        // 尝试自动挑一个当日该窗口空闲包厢直接重排
        let swapped = '';
        try { swapped = await pickFreeRoom(r.date, r.expectedArrival || '', r.partySize); } catch (e) { console.warn('[reject] swap', e.message); }
        if (swapped) {
          let dishSnapshot;
          if (Array.isArray(r.dishes) && r.dishes.length) {
            dishSnapshot = r.dishes.map((d) => ({ dish_id: d.dish_id, name: d.name, image: d.image || '', qty: d.qty || 1, note: d.note || '', sel: d.sel || '' }));
          } else {
            const dishes = (await db.collection('dishes').where({ available: _.neq(false) }).limit(1000).get()).data || [];
            dishSnapshot = dishes.map((d) => ({ dish_id: d._id, name: d.name, image: d.image || '', qty: 1, note: '', sel: '' }));
          }
          await db.collection('bookings').add({
            data: {
              room_id: swapped, date: r.date, slot, type: 'meal', arrival: r.expectedArrival || '',
              dishes: dishSnapshot, guest_name: '', guest_phone: r.contactPhone || '', note: r.note || '',
              reservationRef: r._id, source: 'reservation', created_at: db.serverDate(),
            },
          });
          await db.collection('reservations').doc(p.id).update({ data: { status: 'confirmed', confirmedAt: db.serverDate(), roomNo: swapped, rejectReason: '' } });
          try {
            if (tplId) {
              await cloud.openapi.subscribeMessage.send({
                touser: r._openid,
                templateId: tplId,
                data: {
                  date1: { value: String(r.date || '') },
                  number2: { value: Number(r.partySize) || 0 },
                  thing3: { value: '半山一席私宴' },
                  thing4: { value: '已为您安排 ' + swapped + ' 号包厢' },
                },
              });
            }
          } catch (e) { console.warn('[subscribe]', e.message); }
          return { data: { ok: true, swapped: true, roomId: swapped } };
        }

        // 无可用厢：仅婉拒 + 记录原因（可选）
        await db.collection('reservations').doc(p.id).update({ data: { status: 'rejected', rejectReason: p.reason || '' } });
        return { data: { ok: true, swapped: false } };
      }
      // 店员/老板：代客改预点菜（结论 #5：顾客锁定后商家可改）
      case 'updateReservationDishes': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('reservations');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r) return { error: '预订不存在' };
        if (r.status !== 'confirmed' && r.status !== 'arrived' && r.status !== 'pending_manual') {
          return { error: '仅已确认/到店/待分配的预订可改预点' };
        }
        const dishes = Array.isArray(p.dishes) ? p.dishes : [];
        await db.collection('reservations').doc(p.id).update({ data: { dishes } });
        // 同步 booking 预点快照（若存在），保证后厨配菜单一致
        try {
          const bk = (await db.collection('bookings').where({ reservationRef: r._id }).limit(1).get()).data || [];
          if (bk.length) {
            const snap = dishes.map((d) => ({ dish_id: d.dish_id, name: d.name, image: d.image || '', qty: d.qty || 1, note: d.note || '', sel: d.sel || '' }));
            await db.collection('bookings').doc(bk[0]._id).update({ data: { dishes: snap } });
          }
        } catch (e) { console.warn('[updateResDishes] sync booking', e.message); }
        return { data: { ok: true } };
      }
      // 店员/老板：全部场次（含已关），用于店务管理（发席/关场）
      case 'sessionsAdmin': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('sessions');
        const list = (await db.collection('sessions').orderBy('date', 'asc').orderBy('mealTime', 'asc').limit(1000).get()).data;
        rows = normalize(list.map((s) => ({
          id: s._id, date: s.date, mealTime: s.mealTime,
          capacity: s.capacity || 0, reservedSeats: s.reservedSeats || 0,
          status: s.status, note: s.note || '',
        })));
        break;
      }
      // 老板：关场
      case 'closeSession': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await ensureCol('sessions');
        await db.collection('sessions').doc(p.id).update({ data: { status: 'closed' } });
        return { data: { ok: true } };
      }
      // 老板：超时自动释放（pending > 24h 自动取消；供定时任务调用）
      case 'sweepPending': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await ensureCol('reservations');
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const list = (await db.collection('reservations').where({ status: 'pending' }).limit(1000).get()).data;
        let n = 0;
        for (const r of list) {
          if (tsOf(r.createdAt) && tsOf(r.createdAt) < cutoff) {
            try {
              await db.collection('reservations').doc(r._id).update({ data: { status: 'cancelled' } });
              n++;
            } catch (e) { console.warn('[sweep]', e.message); }
          }
        }
        return { data: { cancelled: n } };
      }

      /* ===== 到店自动标记（结论 #1） ===== */
      // 顾客进入「自己预订的包厢内页」时调用：只把 today + 该包厢 + 已到预计时间附近的 confirmed 预订标 arrived。
      // 关键修复：必须传 roomNo 且校验包厢与时间，避免「看任意厢/凌晨看厢」误标真实预订为到店。
      case 'markArrived': {
        if (!openid) return { error: '身份未就绪' };
        const roomNo = p.roomNo;
        if (!roomNo) return { data: { ok: false, count: 0, skipped: true } }; // 无包厢上下文（如我的/今日页）不误标
        await ensureCol('reservations');
        const today = new Date().toISOString().slice(0, 10);
        const list = (await db.collection('reservations').where({ _openid: openid, room_id: String(roomNo), date: today, status: 'confirmed' }).limit(10).get()).data || [];
        const now = Date.now();
        let n = 0;
        for (const r of list) {
          const serve = serveAtOf(r.date, r.mealTime, r.expectedArrival).getTime();
          // 时间门槛：预计开席前 30 分钟 ~ 后 4 小时之间才算到店，避免凌晨/提前太久误标
          if (now < serve - 30 * 60 * 1000 || now > serve + 4 * 3600 * 1000) continue;
          await db.collection('reservations').doc(r._id).update({ data: { status: 'arrived', arrivedAt: db.serverDate() } });
          n++;
        }
        return { data: { ok: n > 0, count: n } };
      }

      /* ===== 到店双发提醒（结论 #3）：定时任务调用，提前 1 天 / 提前 2 小时各发一次 ===== */
      case 'pushReminders': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await ensureCol('reservations');
        const now = Date.now();
        const list = (await db.collection('reservations').where({ status: 'confirmed' }).limit(1000).get()).data || [];
        let sent = 0;
        for (const r of list) {
          const serve = serveAtOf(r.date, r.mealTime, r.expectedArrival).getTime();
          const dayBefore = serve - 24 * 3600 * 1000;
          const twoHour = serve - 2 * 3600 * 1000;
          // 宽松窗口：未发且「已进入该提醒时点 ~ 之后 24h」内都补发，避免定时任务抖动/漏跑吞掉提醒
          let which = '';
          if (!r.reminded1 && now >= dayBefore && now <= dayBefore + 24 * 3600 * 1000) which = 'reminded1';
          else if (!r.reminded2 && now >= twoHour && now <= twoHour + 6 * 3600 * 1000) which = 'reminded2';
          if (which && tplId) {
            try {
              await cloud.openapi.subscribeMessage.send({
                touser: r._openid, templateId: tplId,
                data: {
                  date1: { value: String(r.date || '') },
                  number2: { value: Number(r.partySize) || 0 },
                  thing3: { value: '半山一席私宴' },
                  thing4: { value: r.roomNo ? r.roomNo + ' 号包厢' : '敬请期待' },
                },
              });
              await db.collection('reservations').doc(r._id).update({ data: { [which]: true } });
              sent++;
            } catch (e) { console.warn('[remind]', e.message); }
          }
        }
        return { data: { sent } };
      }

      /* ===== 每日开门清零售罄标记（结论 #18尾）：定时任务调用，重置 dishes.soldOut/limited ===== */
      case 'resetDailyFlags': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        const list = (await db.collection('dishes').limit(1000).get()).data || [];
        const flagged = list.filter((d) => d.soldOut || d.limited);
        let n = 0;
        for (const d of flagged) {
          try { await db.collection('dishes').doc(d._id).update({ data: { soldOut: false, limited: false } }); n++; } catch (e) {}
        }
        return { data: { reset: n } };
      }

      /* ===== 电子收据列表（结论 #E） ===== */
      case 'listReceipts': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await ensureCol('receipts');
        const list = (await db.collection('receipts').orderBy('created_at', 'desc').limit(1000).get()).data || [];
        rows = list.map((rc) => ({
          id: rc._id, no: rc.no, room_no: rc.room_no, room_name: rc.room_name,
          date: rc.date, time: rc.time, phoneLast4: rc.phoneLast4 || '',
          total: rc.total, paymentMethod: rc.paymentMethod, paid: !!rc.paid,
          invoiced: !!rc.invoiced, itemCount: (rc.items || []).length,
          lines: (rc.items || []).map((it) => ({ name: it.name, qty: it.qty, unitPrice: it.unitPrice, sel: it.sel || '', subtotal: it.subtotal })),
          createdText: String(rc.created_at || '').slice(0, 16),
        }));
        break;
      }

      default:
        return { error: '未知的 action: ' + action };
    }
    return { data: rows || [] };
  } catch (e) {
    console.error('[dataApi]', action, e.message);
    return { error: e.message || '未知错误' };
  }
};
