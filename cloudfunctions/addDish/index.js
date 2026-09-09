// 云函数 addDish —— 新增菜品
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { name, category, price, image } = event
  if (!name || price == null) return { error: '参数缺失' }
  const res = await db.collection('dishes').add({
    data: { name, category, price, status: '在售', image: image || '' }
  })
  return { _id: res._id }
}
