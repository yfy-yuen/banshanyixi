// 统一客人显示称呼（2026-09-26 用户定稿规则）：「尊客」两个字永远在最前。
// 后缀优先级：自定义称呼 > 预订称呼(guestName) > 手机尾号4位 > 预订日期MMDD（如 10月9日 → 1009）
// 示例：尾号 5734 → 「尊客5734」；预订称呼「陈小姐」→ 「尊客陈小姐」。
function guestTitle(opts) {
  const o = opts || {};
  const clean = (s) => (s === null || s === undefined ? '' : String(s).trim());
  const custom = clean(o.custom);            // 「我的」页改称呼存的自定义称呼（本地 profile.name）
  const guestName = clean(o.guestName);      // 预订时填的称呼（reservations.guestName / bookings.guest_name）
  const digits = clean(o.phone).replace(/\D/g, ''); // 兼容明文/脱敏（138****5734 → 1385734）
  const tail = digits.length >= 4 ? digits.slice(-4) : '';
  const d = clean(o.date);                   // 'YYYY-MM-DD'
  const mmdd = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5, 7) + d.slice(8, 10) : '';
  return '尊客' + (custom || guestName || tail || mmdd);
}

module.exports = { guestTitle };
