// 「我的今日」：客人点开门页「入席去」进入。按微信身份自动查今天已确认的预订，
// 显示对应包厢与预点菜；若无预订则引导去订位。无操作、只读，符合私人小馆「客人只点菜」定位。
const { ROOMS } = require('../../utils/config');
const { whoami, myReservations, markArrived } = require('../../utils/api');

function mealLabel(m) { return m === 'dinner' ? '晚市' : '午市'; }
// 到店可读时间：优先顾客填的预计到店时间，否则回退午市 11:30 / 晚市 17:30
function arriveText(r) {
  const hm = (r.expectedArrival && /^\d{1,2}:\d{2}$/.test(r.expectedArrival)) ? r.expectedArrival : (r.mealTime === 'dinner' ? '17:30' : '11:30');
  return mealLabel(r.mealTime || 'lunch') + ' ' + hm;
}

Page({
  data: {
    loading: true,
    has: false,
    info: null,
    dishes: [],
  },
  onShow() {
    // 结论 #1：「我的今日」页无包厢上下文，不自动标到店（避免误标）；到店标记改由进入具体包厢内页触发
    markArrived('').catch(() => {});
    this.load();
  },
  todayStr() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  async load() {
    this.setData({ loading: true });
    try {
      await whoami(); // 触发角色缓存；失败也不阻断
      const list = await myReservations();
      const today = this.todayStr();
      const mine = (list || []).filter(
        (r) => r.status === 'confirmed' && (r.date || '').slice(0, 10) === today
      );
      if (mine.length) {
        const r = mine[0];
        const dishes = r.dishes || r.preorder || [];
        // 前端用 ROOMS 映射真实包厢名（如「知来」），避免显示「包厢6号」回退文本
        const roomName = r.roomName || (r.roomId ? (ROOMS[r.roomId] || (r.roomId + ' 号包厢')) : (r.roomNo ? (ROOMS[r.roomNo] || (r.roomNo + ' 号包厢')) : ''));
        const info = { ...r, roomName, arriveText: arriveText(r) };
        this.setData({ has: true, info, dishes, loading: false });
      } else {
        this.setData({ has: false, loading: false, info: null, dishes: [] });
      }
    } catch (e) {
      this.setData({ loading: false, has: false });
    }
  },
  goReserve() {
    wx.switchTab({ url: '/pages/reserve/reserve' });
  },
});
