// 云函数 createOrder —— 提交订单，并自动写记账（ledger 收入）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { tableNo, items } = event
  if (!tableNo || !items || !items.length) return { error: '参数缺失' }

  const total = items.reduce((s, i) => s + i.price * i.qty, 0)

  const orderRes = await db.collection('orders').add({
    data: {
      tableNo,
      items,
      totalAmount: total,
      status: '已下单',
      createdAt: db.serverDate(),
      remark: ''
    }
  })
  const orderId = orderRes._id

  await Promise.all(items.map(i => db.collection('order_items').add({
    data: { orderId, dishId: i.dishId, name: i.name, price: i.price, qty: i.qty, category: i.category }
  })))

  // 自动记账：一笔收入写入 ledger（对应你的记账结构）
  await db.collection('ledger').add({
    data: {
      orderId,
      type: '收入',
      category: '餐饮',
      amount: total,
      date: db.serverDate(),
      tableNo,
      账本类型: '门店账本',
      remark: '桌号' + tableNo
    }
  })

  return { orderId }
}
