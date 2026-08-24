const { ROOMS } = require('../../utils/config');
const { myReservations, cancelReservation, markArrived, genInvite, resetInvite, removeCompanion } = require('../../utils/api');

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
    active: [], history: [], preorders: [],
    loading: false,
    showNameModal: false, nameInput: '',
    showShare: false, shareItem: null, shareCode: '', shareQrcode: '', shareBusy: false,
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
      const stored = wx.getStorageSync('profile') || {};
      const phone = (list[0] && list[0].contactPhone) || stored.phone || '';
      this.setData({
        name: stored.name || '',
        phoneMask: maskPhone(phone),
        active, history, preorders,
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
  // 同桌邀请：打开分享面板（自动取/生成邀请码 + 小程序码）
  openShare(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.active.find((x) => x.id === id) || this.data.history.find((x) => x.id === id);
    if (!item) return;
    this.setData({ showShare: true, shareItem: item, shareCode: item.inviteCode || '', shareQrcode: '', shareBusy: false });
    this.genCode(id);
  },
  async genCode(id) {
    this.setData({ shareBusy: true });
    try {
      const r = await genInvite(id);
      this.setData({ shareCode: r.code || '', shareQrcode: r.qrcode || '' });
    } catch (err) { console.warn('[genInvite]', err.message); }
    this.setData({ shareBusy: false });
  },
  closeShare() { this.setData({ showShare: false }); },
  copyCode() {
    if (!this.data.shareCode) return;
    wx.setClipboardData({ data: this.data.shareCode, success: () => wx.showToast({ title: '已复制邀请码', icon: 'success' }) });
  },
  async resetCode() {
    const item = this.data.shareItem;
    if (!item) return;
    const ok = await new Promise((res) => wx.showModal({ title: '重置邀请码', content: '旧码将立即失效，已加入的同桌不受影响。', success: (r) => res(r.confirm) }));
    if (!ok) return;
    try {
      const r = await resetInvite(item.id);
      this.setData({ shareCode: r.code || '', shareQrcode: '' });
      wx.showToast({ title: '已重置', icon: 'success' });
    } catch (e) { wx.showToast({ title: '重置失败', icon: 'none' }); }
  },
  async kickCompanion() {
    const item = this.data.shareItem;
    if (!item) return;
    const ok = await new Promise((res) => wx.showModal({ title: '移除同桌', content: '将把同桌移出本桌，对方需重新扫码/输码加入。', success: (r) => res(r.confirm) }));
    if (!ok) return;
    try {
      const r = await removeCompanion(item.id);
      if (r && r.ok) {
        const active = this.data.active.map((x) => x.id === item.id ? { ...x, companionCount: r.companionCount } : x);
        this.setData({ active, shareItem: { ...item, companionCount: r.companionCount } });
        wx.showToast({ title: '已移除', icon: 'success' });
      }
    } catch (e) { wx.showToast({ title: '操作失败', icon: 'none' }); }
  },
  onShareAppMessage() {
    const item = this.data.shareItem || {};
    const code = this.data.shareCode || '';
    const room = item.roomNo || '';
    const id = item.id || '';
    return {
      title: '半山·一席 | ' + (item.date || '') + ' 邀您同桌入席',
      path: '/pages/room/room?room=' + room + '&join=' + id + '&code=' + code,
    };
  },
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
