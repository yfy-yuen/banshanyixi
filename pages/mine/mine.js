const { ROOMS } = require('../../utils/config');
const { myReservations, cancelReservation, markArrived } = require('../../utils/api');

function mealLabel(m) { return m === 'dinner' ? '晚市' : '午市'; }
function statusText(s) {
  return ({ pending: '审核中', confirmed: '已确认', rejected: '已婉拒', cancelled: '已取消' })[s] || s;
}
function maskPhone(p) {
  if (!p) return '';
  return p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : p;
}

Page({
  data: {
    name: '', phoneMask: '',
    active: [], history: [], preorders: [], favorites: [],
    loading: false,
    showNameModal: false, nameInput: '',
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selectedKey: 'mine' });
    }
    // 结论 #1：「我的」页无包厢上下文，不自动标到店（避免误标）；到店标记改由进入具体包厢内页触发
    // markArrived() 传空 → 后端跳过。保留调用以便将来若加"当前预订入口"可传入 roomNo。
    markArrived('').catch(() => {});
    this.load();
  },
  async load() {
    this.setData({ loading: true });
    try {
      const list = (await myReservations()) || [];
      const mapped = list.map((r) => ({
        ...r,
        mealText: mealLabel(r.mealTime),
        statusText: statusText(r.status),
        roomText: r.roomId ? (ROOMS[r.roomId] || (r.roomId + ' 号包厢')) : '',
        dishes: (r.dishes || []).map((d) => ({ name: d.name, qty: d.qty || 1, selText: d.selText || '' })),
        step: r.status === 'confirmed' ? ((r.dishes || []).length ? 2 : 1) : 0,
      }));
      const active = mapped.filter((r) => r.status === 'pending' || r.status === 'confirmed');
      const history = mapped.filter((r) => r.status === 'rejected' || r.status === 'cancelled');
      const preorders = active
        .filter((r) => r.status === 'confirmed' && r.dishes.length)
        .map((r) => ({ id: r.id, date: r.date, roomText: r.roomText, dishes: r.dishes, locked: true }));
      const agg = {};
      mapped.forEach((r) => (r.dishes || []).forEach((d) => {
        const k = d.name;
        agg[k] = (agg[k] || 0) + (d.qty || 1);
      }));
      const favorites = Object.keys(agg)
        .map((k) => ({ name: k, count: agg[k] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
      const stored = wx.getStorageSync('profile') || {};
      const phone = (list[0] && list[0].contactPhone) || stored.phone || '';
      this.setData({
        name: stored.name || '',
        phoneMask: maskPhone(phone),
        active, history, preorders, favorites,
      });
    } catch (e) {
      console.warn('[mine]', e);
    }
    this.setData({ loading: false });
  },
  goReserve() { wx.navigateTo({ url: '/pages/reserve/reserve' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
  editName() { this.setData({ showNameModal: true, nameInput: this.data.name }); },
  onNameInput(e) { this.setData({ nameInput: e.detail.value }); },
  closeName() { this.setData({ showNameModal: false }); },
  noop() {},
  saveName() {
    const name = (this.data.nameInput || '').trim();
    const stored = wx.getStorageSync('profile') || {};
    stored.name = name;
    wx.setStorageSync('profile', stored);
    this.setData({ name, showNameModal: false });
  },
  editPreorder(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/menu/menu?mode=preorder&reservationId=' + id });
  },
  async cancelMine(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const ok = await new Promise((res) => wx.showModal({
      title: '取消预订', content: '确定取消该预订申请？', success: (r) => res(r.confirm),
    }));
    if (!ok) return;
    wx.showLoading({ title: '取消中' });
    try {
      await cancelReservation(id);
      wx.hideLoading();
      wx.showToast({ title: '已取消', icon: 'success' });
      this.load();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '取消失败', icon: 'none' });
    }
  },
  mealLabel, statusText,
});
