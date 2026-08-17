// 一次性回填菜品标签（cloud1 文档库版）
// 部署后在微信开发者工具「云开发 → 云函数 → backfillTags → 测试」调用一次即可。
// 仅给 dishes 文档补充 tags 字段（招牌/辣/素/时令），用 update 局部更新，不覆盖其它字段。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 与 initData 一致的推断规则：分类/名称/描述 -> 标签
function inferTags(d) {
  const tags = [];
  const cat = d.category || '';
  const name = d.name || '';
  const desc = d.description || '';
  if (cat === '招牌') tags.push('招牌');
  if (cat === '素菜') tags.push('素');
  if (name.indexOf('辣') >= 0 || name.indexOf('椒') >= 0 || desc.indexOf('辣') >= 0) tags.push('辣');
  if (name.indexOf('时令') >= 0 || desc.indexOf('时令') >= 0 || desc.indexOf('当季') >= 0) tags.push('时令');
  return tags;
}

exports.main = async () => {
  try {
    const res = await db.collection('dishes').limit(1000).get();
    const list = res.data || [];
    let updated = 0;
    let skipped = 0;
    for (const d of list) {
      const tags = inferTags(d);
      const old = Array.isArray(d.tags) ? d.tags : [];
      const same = JSON.stringify(old.slice().sort()) === JSON.stringify(tags.slice().sort());
      if (!same) {
        await db.collection('dishes').doc(d._id).update({ data: { tags } });
        updated++;
      } else {
        skipped++;
      }
    }
    return { data: { ok: true, total: list.length, updated, skipped } };
  } catch (e) {
    console.error('[backfillTags]', e.message);
    return { error: e.message };
  }
};
