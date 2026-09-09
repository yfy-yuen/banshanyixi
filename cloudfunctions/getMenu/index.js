// 云函数 getMenu —— 获取菜品列表
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const w = {}
  if (!event.all) w.status = '在售'
  const res = await db.collection('dishes').where(w).orderBy('category', 'asc').get()
  const list = res.data

  // 把菜品图片的 cloud:// fileID 转换为临时访问地址，确保顾客端能正常显示
  const imgDishes = list.filter(d => d.image)
  if (imgDishes.length) {
    const { fileList } = await cloud.getTempFileURL({ fileList: imgDishes.map(d => d.image) })
    const urlMap = {}
    fileList.forEach(u => { urlMap[u.fileID] = u.tempFileURL })
    list.forEach(d => { if (d.image) d.image = urlMap[d.image] || d.image })
  }
  return { data: list }
}
