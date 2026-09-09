// 云函数 getReport —— 营收统计（总额 + 按分类汇总）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const $ = db.command.aggregate

exports.main = async () => {
  const totalRes = await db.collection('ledger')
    .aggregate()
    .group({ _id: null, total: $.sum('$amount') })
    .end()
  const total = (totalRes.list[0] && totalRes.list[0].total) || 0

  const catRes = await db.collection('ledger')
    .aggregate()
    .group({ _id: '$category', total: $.sum('$amount') })
    .end()

  return { total, byCategory: catRes.list }
}
