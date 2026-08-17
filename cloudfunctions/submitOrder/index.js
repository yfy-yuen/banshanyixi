// 提交包厢订单（cloud1 文档数据库版）
// 由 CloudBase PG REST API 改为 wx-server-sdk 文档库。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  try {
    const { roomNo, roomName, people, items, total, note } = event || {};
    const res = await db.collection('orders').add({
      data: {
        room_no: roomNo,
        room_name: roomName,
        people,
        items,
        total,
        note: note || '',
        status: 'unpaid',
        created_at: db.serverDate(),
      },
    });
    return { data: { ok: true, id: res._id } };
  } catch (e) {
    console.error('[submitOrder] exception:', e.message);
    return { error: e.message || '提交订单失败' };
  }
};
