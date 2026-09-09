// 云函数 settleOrder —— 结账（把订单标记为已结账）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  if (!event.orderId) return { error: '缺少 orderId' }
  await db.collection('orders').doc(event.orderId).update({ data: { status: '已结账' } })
  return { ok: true }
}
