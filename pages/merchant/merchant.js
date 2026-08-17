const { CATS, fmt, ROOMS } = require('../../utils/config');
const {
  getMerchantOrders, settleOrder, getDishesAdmin, saveDish, deleteDish, getPaymentQrcodes, saveQr, callApi,
} = require('../../utils/api');

function decorateOrder(o) {
  const items = (o.items || []).map((i) => ({
    ...i,
    selText: i.sel && Object.keys(i.sel).length ? '（' + Object.values(i.sel).join('/') + '）' : '',
  }));
  return {
    ...o, items, totalText: fmt(o.total),
    paidText: o.status === 'paid' ? '已支付' : '未支付',
    createdText: (o.created_at || '').replace('T', ' ').slice(0, 16),
  };
}

// 棋牌分午间/晚间；用餐分午/晚
function bookingLabel(b) {
  if (b.type === 'game') return b.slot === 'lunch' ? '午间棋牌' : '晚间棋牌';
  return b.slot === 'lunch' ? '午餐订餐' : '晚餐订餐';
}

Page({
  data: {
    role: '', isManager: false, isStaff: false, noPerm: false,
    tab: 'orders',
    orderSub: 'book',
    mOrders: [], mBookings: [], mDishes: [],
    repMode: 'day', repDate: '', repRows: [], repTotalText: '', repCount: 0,
    qrMap: {},
    showEdit: false, editId: '__new__', edit: null, cats: CATS, catsIndex: 0,
    tagOptions: ['招牌', '辣', '素', '时令'],
    staffList: [], requests: [],
  },
  onLoad() {
    this.setData({ repDate: new Date().toISOString().slice(0, 10) });
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selectedKey: 'merchant' });
    }
    const app = getApp();
    const role = app.globalData.role;
    if (role === '') { app.refreshRole().then(() => this.onShow()); return; }
    const isManager = role === 'manager';
    const isStaff = role === 'clerk' || role === 'manager';
    this.setData({
      role: isManager ? '老板' : (role === 'clerk' ? '店员' : ''),
      isManager, isStaff,
    });
    if (!isStaff) { this.setData({ noPerm: true }); return; }
    this.setData({ noPerm: false });
    this.renderMerchant();
    if (isManager) this.loadStaff();
  },
  noop() {},
  tabs() {
    // 店员：仅「订单」（看不到菜品改价/报表/收款码/员工）
    // 老板：全部
    if (this.data.isManager) {
      return [['orders', '订单'], ['dishes', '菜品'], ['report', '报表'], ['qr', '收款码'], ['staff', '员工']];
    }
    return [['orders', '订单']];
  },
  renderMerchant() {
    const tabs = this.tabs();
    if (!tabs.find((t) => t[0] === this.data.tab)) this.setData({ tab: 'orders' });
    if (this.data.tab === 'orders') this.renderMOrders();
    else if (this.data.tab === 'dishes') this.renderMDishes();
    else if (this.data.tab === 'report') this.renderReport();
    else if (this.data.tab === 'qr') this.renderQr();
    else if (this.data.tab === 'staff') this.loadStaff();
  },
  switchMerchant(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.renderMerchant();
  },
  switchOrderSub(e) {
    this.setData({ orderSub: e.currentTarget.dataset.sub });
    this.renderMOrders();
  },

  /* 订单：订餐菜品 / 现场下单菜品 */
  renderMOrders() {
    if (this.data.orderSub === 'book') this.loadBookings();
    else this.loadLiveOrders();
  },
  async loadLiveOrders() {
    try {
      const raw = await getMerchantOrders();
      this.setData({ mOrders: (raw || []).map(decorateOrder) });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  async loadBookings() {
    try {
      const b = await callApi('bookings');
      this.setData({
        mBookings: (b || []).map((x) => ({
          ...x,
          roomName: ROOMS[x.room_id] || x.room_id,
          label: bookingLabel(x),
          dishList: (x.dishes || []).map((d) => d.name + ' ×' + (d.qty || 1)).join('、') || '—',
          guestText: x.guest_name ? (x.guest_name + (x.guest_phone ? ' ' + x.guest_phone : '')) : '—',
        })),
      });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  async settleOrder(e) {
    const id = e.currentTarget.dataset.id;
    wx.showLoading({ title: '处理中' });
    try { await settleOrder(id); this.renderMOrders(); }
    catch (err) { wx.showToast({ title: '操作失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },

  /* 菜品 */
  async renderMDishes() {
    try {
      const raw = await getDishesAdmin();
      this.setData({
        mDishes: (raw || []).map((d) => ({ ...d, priceText: fmt(d.price), ph: (d.name || '?').charAt(0) })),
      });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    let edit;
    if (id === '__new__') {
      edit = { name: '', category: CATS[0], price: '', image: '', description: '', specs: [], tags: [] };
    } else {
      const d = this.data.mDishes.find((x) => x.id === id);
      const known = ['招牌', '辣', '素', '时令'];
      edit = { name: d.name, category: d.category, price: String(d.price), image: d.image || '', description: d.description || '', specs: d.specs || [], tags: (d.tags || []).filter((t) => known.indexOf(t) >= 0) };
    }
    this.setData({ showEdit: true, editId: id, edit, catsIndex: Math.max(0, CATS.indexOf(edit.category)) });
  },
  onEditInput(e) {
    const f = e.currentTarget.dataset.field;
    this.setData({ ['edit.' + f]: e.detail.value });
  },
  onTagToggle(e) {
    const t = e.currentTarget.dataset.tag;
    const cur = this.data.edit.tags || [];
    const next = cur.indexOf(t) >= 0 ? cur.filter((x) => x !== t) : cur.concat(t);
    this.setData({ 'edit.tags': next });
  },
  onCatPick(e) {
    this.setData({ 'edit.category': this.data.cats[e.detail.value], catsIndex: e.detail.value });
  },
  closeEdit() { this.setData({ showEdit: false }); },
  async saveDish() {
    const ed = this.data.edit;
    if (!ed.name || !ed.name.trim()) { wx.showToast({ title: '请填写菜名', icon: 'none' }); return; }
    const payload = {
      name: ed.name.trim(), category: ed.category,
      price: Number(ed.price) || 0, image: ed.image || '',
      description: ed.description || '', specs: ed.specs || [],
      tags: ed.tags || [], available: true,
    };
    wx.showLoading({ title: '保存中' });
    try {
      await saveDish(this.data.editId, payload);
      this.setData({ showEdit: false });
      this.renderMDishes();
    } catch (e) { wx.showToast({ title: '保存失败：' + (e.message || ''), icon: 'none' }); }
    finally { wx.hideLoading(); }
  },
  async deleteDish(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((res) => wx.showModal({ title: '删除菜品', content: '确定删除？', success: (r) => res(r.confirm) }));
    if (!ok) return;
    wx.showLoading({ title: '删除中' });
    try { await deleteDish(id); this.renderMDishes(); }
    catch (err) { wx.showToast({ title: '删除失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },

  /* 报表 */
  setRep(e) { this.setData({ repMode: e.currentTarget.dataset.mode }); this.renderReport(); },
  onRepDate(e) { this.setData({ repDate: e.detail.value }); this.renderReport(); },
  async renderReport() {
    try {
      const raw = await getMerchantOrders();
      const paid = (raw || []).filter((o) => o.status === 'paid');
      if (this.data.repMode === 'day') {
        const rows = paid.filter((o) => (o.paid_at || o.created_at).slice(0, 10) === this.data.repDate);
        const total = rows.reduce((s, o) => s + o.total, 0);
        this.setData({ repRows: rows.map(decorateOrder), repTotalText: fmt(total), repCount: rows.length });
      } else {
        const hour = (h) => (h < 11 ? '早市' : h < 14 ? '午市' : h < 17 ? '下午茶' : h < 21 ? '晚市' : '夜宵');
        const bySlot = {};
        paid.filter((o) => (o.paid_at || o.created_at).slice(0, 10) === this.data.repDate)
          .forEach((o) => { const h = new Date(o.paid_at || o.created_at).getHours(); const k = hour(h); bySlot[k] = (bySlot[k] || 0) + o.total; });
        const slots = Object.entries(bySlot).map(([k, v]) => ({ k, v: fmt(v) }));
        const total = Object.values(bySlot).reduce((s, v) => s + v, 0);
        this.setData({ repRows: slots, repTotalText: fmt(total), repCount: slots.length });
      }
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },

  /* 收款码 */
  async renderQr() {
    try {
      const raw = await getPaymentQrcodes();
      const map = {};
      (raw || []).forEach((r) => { map[r.channel] = r.image_url; });
      this.setData({ qrMap: map });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  onQrInput(e) {
    const ch = e.currentTarget.dataset.ch;
    this.setData({ ['qrMap.' + ch]: e.detail.value });
  },
  async saveQr(e) {
    const ch = e.currentTarget.dataset.ch;
    const url = (this.data.qrMap[ch] || '').trim();
    wx.showLoading({ title: '保存中' });
    try { await saveQr(ch, url); wx.showToast({ title: '已保存', icon: 'success' }); }
    catch (err) { wx.showToast({ title: '保存失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },

  /* 员工管理（店长） */
  async loadStaff() {
    try {
      const s = await callApi('staff');
      this.setData({ staffList: s || [] });
      const r = await callApi('staffRequests');
      this.setData({ requests: r || [] });
    } catch (e) { console.warn('[merchant] staff', e); }
  },
  async approveRequest(e) {
    const { openid, name } = e.currentTarget.dataset;
    wx.showActionSheet({
      itemList: ['设为店员', '设为店长'],
      success: async (res) => {
        const role = res.tapIndex === 1 ? 'manager' : 'clerk';
        wx.showLoading({ title: '审批中' });
        try {
          await callApi('approveStaff', { openid, name, role, invited_by: getApp().globalData.uid });
          wx.hideLoading();
          this.loadStaff();
          wx.showToast({ title: '已通过', icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '失败', icon: 'none' });
        }
      },
    });
  },
  async removeStaff(e) {
    const openid = e.currentTarget.dataset.openid;
    const ok = await new Promise((res) => wx.showModal({ title: '移除员工', content: '确定移除？', success: (r) => res(r.confirm) }));
    if (!ok) return;
    try { await callApi('removeStaff', { openid }); this.loadStaff(); }
    catch (err) { wx.showToast({ title: '失败', icon: 'none' }); }
  },

  /* 申请成为员工（顾客入口） */
  applyStaff() {
    const app = getApp();
    if (!app.globalData.uid) { wx.showToast({ title: '身份未就绪', icon: 'none' }); return; }
    wx.showModal({
      title: '申请成为员工', editable: true, placeholderText: '输入你的姓名',
      success: async (res) => {
        if (res.confirm && res.content) {
          try {
            await callApi('requestStaff', { openid: app.globalData.uid, name: res.content });
            wx.showToast({ title: '已提交，等待店长审批', icon: 'none' });
          } catch (e) { wx.showToast({ title: '提交失败', icon: 'none' }); }
        }
      },
    });
  },
});
