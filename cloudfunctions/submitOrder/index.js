// 提交包厢订单（cloud1 文档数据库版）
// 由 CloudBase PG REST API 改为 wx-server-sdk 文档库。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  try {
    const { roomNo, roomName, people, items, total, note } = event || {};
    const ctx = cloud.getWXContext();
    const openid = ctx.OPENID || '';
    // 反查当前顾客在本厢今天的预订（用于把现场单归属到具体一桌，支撑「精确到本桌」门禁）
    // 无预订的散客 reservation_id 留空，roomAccess 会按 openid 让其看到自己的单
    let reservationId = '';
    try {
      const date = new Date().toISOString().slice(0, 10);
      const bks = (await db.collection('bookings').where({ room_id: String(roomNo), date }).limit(1000).get()).data || [];
      const refs = [...new Set(bks.map((b) => b.reservationRef).filter(Boolean))];
      if (refs.length) {
        const rs = (await db.collection('reservations').where({ _id: _.in(refs) }).limit(1000).get()).data || [];
        const mine = rs.find((r) => r._openid === openid || (r.companions || []).includes(openid));
        if (mine) reservationId = mine._id;
      }
    } catch (e) { console.warn('[submitOrder reserveLookup]', e.message); }
    const res = await db.collection('orders').add({
      data: {
        room_no: roomNo,
        room_name: roomName,
        people,
        items,
        total,
        note: note || '',
        status: 'unpaid',
        openid,
        reservation_id: reservationId,
        created_at: db.serverDate(),
      },
    });
    return { data: { ok: true, id: res._id } };
  } catch (e) {
    console.error('[submitOrder] exception:', e.message);
    return { error: e.message || '提交订单失败' };
  }
};
