// 云函数 getOrders —— 获取订单列表（附带每单的菜品明细）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const w = {}
  if (event.status) w.status = event.status

  const orders = (await db.collection('orders')
    .where(w)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()).data

  for (const o of orders) {
    o.items = (await db.collection('order_items').where({ orderId: o._id }).get()).data
  }
  return { data: orders }
}
