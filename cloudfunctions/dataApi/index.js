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

// 包厢编号（与 utils/config.js ROOMS 一致，无 4 号）；确认预订时用于自动分配空闲包厢
const ROOM_IDS = ['1', '2', '3', '5', '6'];

// 把文档库返回的 _id 暴露为 id（前端代码统一用 .id 匹配）
function normalize(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => (r && r._id !== undefined ? { ...r, id: r._id } : r));
}

// 预订系统辅助：集合自创建 / 手机号脱敏 / 开席时间
async function ensureCol(name) {
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
}
function maskPhone(s) {
  if (!s) return '';
  return String(s).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}
// 开席时间：午市 11:30 / 晚市 17:30，用于「到店前 4 小时可取消」窗口
function serveAtOf(date, mealTime) {
  const hm = mealTime === 'dinner' ? '17:30' : '11:30';
  return new Date(date + 'T' + hm + ':00');
}
function tsOf(v) {
  if (!v) return 0;
  if (v.getTime) return v.getTime();
  if (v.$date) return new Date(v.$date).getTime();
  return new Date(v).getTime();
}

exports.main = async (event) => {
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
        else rows = normalize((await db.collection('bookings').limit(1000).get()).data);
        break;

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

      /* ===== 写（店员/老板：结算本桌订单） ===== */
      case 'settleOrder': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await db.collection('orders').doc(p.id).update({ data: { status: 'paid', paid_at: db.serverDate() } });
        return { data: { ok: true } };
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
      case 'saveBooking': {
        if (!(await isStaffOf())) return { error: '无权限' };
        const b = p.booking || {};
        const data = {
          room_id: b.room_id, date: b.date, slot: b.slot, type: b.type,
          dishes: b.dishes, guest_name: b.guest_name, guest_phone: b.guest_phone, note: b.note,
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
      // 顾客：提交预约申请（原子占用余位，防并发超订）
      case 'submitReservation': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('sessions'); await ensureCol('reservations');
        const ps = Number(p.partySize);
        if (!ps || ps < 1) return { error: '请填写有效人数' };
        if (!/^1[3-9]\d{9}$/.test(p.contactPhone || '')) return { error: '请填写正确的 11 位手机号' };
        const s = (await db.collection('sessions').doc(p.sessionRef).get()).data;
        if (!s || s.status !== 'open') return { error: '该场次不可预订' };
        const t = await db.startTransaction();
        try {
          const cur = (await t.collection('sessions').doc(p.sessionRef).get()).data;
          const rem = (cur.capacity || 0) - (cur.reservedSeats || 0);
          if (rem < ps) { await t.rollback(); return { error: '余位不足' }; }
          await t.collection('sessions').doc(p.sessionRef).update({ data: { reservedSeats: _.inc(ps) } });
          const _id = (await t.collection('reservations').add({
            data: {
              _openid: openid, sessionRef: p.sessionRef, partySize: ps,
              contactPhone: p.contactPhone, note: p.note || '', status: 'pending',
              source: 'self', createdAt: db.serverDate(),
            },
          }))._id;
          await t.commit();
          return { data: { id: _id, status: 'pending' } };
        } catch (err) {
          try { await t.rollback(); } catch (e) {}
          return { error: err.message || '提交失败' };
        }
      }
      // 顾客：我的预订（自身）
      case 'myReservations': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('reservations'); await ensureCol('sessions'); await ensureCol('bookings');
        const list = (await db.collection('reservations').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(1000).get()).data;
        const refs = [...new Set(list.map((r) => r.sessionRef))];
        const sessList = refs.length ? (await db.collection('sessions').where({ _id: _.in(refs) }).limit(1000).get()).data : [];
        const sessMap = {};
        sessList.forEach((s) => { sessMap[s._id] = { date: s.date, mealTime: s.mealTime, note: s.note || '' }; });
        // 关联自动排席的包厢：确认时 confirmReservation 会生成 booking，reservationRef 回指本预订
        // 一次联查回传 roomId，让顾客端确认后能直接看到「被安排在 X 号包厢」
        const bks = refs.length ? (await db.collection('bookings').where({ reservationRef: _.in(refs) }).limit(1000).get()).data : [];
        const bkMap = {};
        bks.forEach((b) => { if (!bkMap[b.reservationRef]) bkMap[b.reservationRef] = b.room_id; });
        rows = list.map((r) => ({
          id: r._id, sessionRef: r.sessionRef, partySize: r.partySize,
          contactPhone: maskPhone(r.contactPhone), note: r.note || '', status: r.status,
          source: r.source, createdAt: r.createdAt, session: sessMap[r.sessionRef] || {},
          roomId: bkMap[r._id] || null,
        }));
        break;
      }
      // 顾客：取消（仅 pending/confirmed，且距开席 > 4h；回减余位）
      case 'cancelReservation': {
        if (!openid) return { error: '身份未就绪' };
        await ensureCol('reservations'); await ensureCol('sessions');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r || r._openid !== openid) return { error: '无权限' };
        if (r.status !== 'pending' && r.status !== 'confirmed') return { error: '当前状态不可取消' };
        const s = (await db.collection('sessions').doc(r.sessionRef).get()).data;
        const serve = s ? serveAtOf(s.date, s.mealTime) : null;
        if (serve && (serve.getTime() - Date.now()) < 4 * 3600 * 1000) return { error: '距开席不足 4 小时，无法自助取消' };
        const t = await db.startTransaction();
        try {
          await t.collection('reservations').doc(p.id).update({ data: { status: 'cancelled' } });
          if (s) await t.collection('sessions').doc(r.sessionRef).update({ data: { reservedSeats: _.inc(-r.partySize) } });
          await t.commit();
        } catch (err) { try { await t.rollback(); } catch (e) {} return { error: err.message || '取消失败' }; }
        // 同步释放关联的包厢排席（确认时自动生成的 booking）
        try {
          const linked = (await db.collection('bookings').where({ reservationRef: p.id }).limit(10).get()).data || [];
          for (const b of linked) { try { await db.collection('bookings').doc(b._id).remove(); } catch (e) {} }
        } catch (e) { console.warn('[cancel] booking', e.message); }
        return { data: { ok: true } };
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
      // 老板/店员：全部预订（列表脱敏；明文仅老板可见）
      case 'listReservations': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('reservations'); await ensureCol('sessions');
        const isMgr = (await roleOf()) === 'manager';
        const list = (await db.collection('reservations').orderBy('createdAt', 'desc').limit(1000).get()).data;
        const refs = [...new Set(list.map((r) => r.sessionRef))];
        const sessList = refs.length ? (await db.collection('sessions').where({ _id: _.in(refs) }).limit(1000).get()).data : [];
        const sessMap = {};
        sessList.forEach((s) => { sessMap[s._id] = { date: s.date, mealTime: s.mealTime, note: s.note || '' }; });
        rows = list.map((r) => ({
          id: r._id, sessionRef: r.sessionRef, partySize: r.partySize,
          contactPhone: maskPhone(r.contactPhone), phonePlain: isMgr ? (r.contactPhone || '') : '',
          note: r.note || '', status: r.status, source: r.source, createdAt: r.createdAt,
          session: sessMap[r.sessionRef] || {},
        }));
        break;
      }
      // 老板/店员：确认（翻转状态 + 自动在 bookings 生成一桌，打通订位与包厢排席）
      case 'confirmReservation': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('reservations'); await ensureCol('sessions'); await ensureCol('bookings');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r) return { error: '预订不存在' };
        if (r.status !== 'pending') return { error: '仅待确认可确认' };
        const s = (await db.collection('sessions').doc(r.sessionRef).get()).data || {};
        const slot = s.mealTime === 'dinner' ? 'dinner' : 'lunch';

        // 自动分配该日期餐段下的空闲包厢（无空闲则仅确认、提示老板手动排席）
        let roomId = '';
        try {
          const occ = (await db.collection('bookings').where({ date: s.date, slot }).limit(1000).get()).data || [];
          const used = new Set(occ.map((b) => String(b.room_id)));
          roomId = ROOM_IDS.find((no) => !used.has(no)) || '';
        } catch (e) { console.warn('[confirm] alloc', e.message); }

        await db.collection('reservations').doc(p.id).update({ data: { status: 'confirmed', confirmedAt: db.serverDate() } });

        let bookingId = '';
        if (roomId) {
          const dishes = (s.menuSnapshot || []).map((d) => ({ dish_id: '', name: d.name, image: d.image || '', qty: 1, note: '' }));
          bookingId = (await db.collection('bookings').add({
            data: {
              room_id: roomId, date: s.date, slot, type: 'meal',
              dishes, guest_name: '', guest_phone: r.contactPhone || '', note: r.note || '',
              reservationRef: r._id, source: 'reservation', created_at: db.serverDate(),
            },
          }))._id;
        }

        // 订阅消息通知顾客（best-effort；需 MP 后台配模板 + 顾客授权，DevTools 收不到）
        try {
          if (process.env.RESERVE_TPL_ID) {
            await cloud.openapi.subscribeMessage.send({
              touser: r._openid,
              templateId: process.env.RESERVE_TPL_ID,
              data: {
                thing1: { value: (s.date || '') + ' ' + (s.mealTime === 'dinner' ? '晚市' : '午市') },
                number2: { value: r.partySize },
                phrase3: { value: '预约已确认' },
              },
            });
          }
        } catch (e) { console.warn('[subscribe]', e.message); }

        return { data: { ok: true, bookingId, roomId, needManualAssign: !roomId } };
      }
      // 老板/店员：婉拒（回减已占用余位）
      case 'rejectReservation': {
        if (!(await isStaffOf())) return { error: '无权限' };
        await ensureCol('reservations'); await ensureCol('sessions');
        const r = (await db.collection('reservations').doc(p.id).get()).data;
        if (!r) return { error: '预订不存在' };
        if (r.status !== 'pending') return { error: '仅待确认可婉拒' };
        const t = await db.startTransaction();
        try {
          await t.collection('reservations').doc(p.id).update({ data: { status: 'rejected' } });
          await t.collection('sessions').doc(r.sessionRef).update({ data: { reservedSeats: _.inc(-r.partySize) } });
          await t.commit();
          return { data: { ok: true } };
        } catch (err) { try { await t.rollback(); } catch (e) {} return { error: err.message || '婉拒失败' }; }
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
      // 老板：超时自动释放（pending > 24h 自动取消并回减余位；供定时任务调用）
      case 'sweepPending': {
        if ((await roleOf()) !== 'manager') return { error: '无权限' };
        await ensureCol('reservations'); await ensureCol('sessions');
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const list = (await db.collection('reservations').where({ status: 'pending' }).limit(1000).get()).data;
        let n = 0;
        for (const r of list) {
          if (tsOf(r.createdAt) && tsOf(r.createdAt) < cutoff) {
            const t = await db.startTransaction();
            try {
              await t.collection('reservations').doc(r._id).update({ data: { status: 'cancelled' } });
              await t.collection('sessions').doc(r.sessionRef).update({ data: { reservedSeats: _.inc(-r.partySize) } });
              await t.commit(); n++;
            } catch (e) { try { await t.rollback(); } catch (e2) {} }
          }
        }
        return { data: { cancelled: n } };
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
