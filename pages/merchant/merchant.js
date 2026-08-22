const { CATS, fmt, ROOMS } = require('../../utils/config');
const {
  getMerchantOrders, settleOrder, clearOrder, listReceipts, pushReminders, resetDailyFlags, getDishesAdmin, saveDish, deleteDish, getPaymentQrcodes, saveQr, callApi, sweepPending,
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
    noteText: (o.note || '').trim(),
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
    mClosed: [], showClosed: false,
    repMode: 'day', repDate: '', repRows: [], repTotalText: '', repCount: 0,
    mReceipts: [], receiptDetail: false,
    qrMap: {},
    showEdit: false, editId: '__new__', edit: null, cats: CATS, catsIndex: 0,
    tagOptions: ['招牌', '辣', '素', '时令'],
    staffList: [], requests: [],
    mView: 'dishes',   // 菜品 tab 内的子视图：dishes 菜品 | rooms 包厢
    mRooms: [],
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
    else if (this.data.tab === 'dishes') this.renderMView();
    else if (this.data.tab === 'report') this.renderReport();
    else if (this.data.tab === 'qr') this.renderQr();
    else if (this.data.tab === 'staff') this.loadStaff();
  },
  // 菜品 tab 内的子视图切换（菜品 / 包厢）
  switchMView(e) {
    this.setData({ mView: e.currentTarget.dataset.view });
    this.renderMView();
  },
  renderMView() {
    if (this.data.mView === 'rooms') this.loadRooms();
    else this.renderMDishes();
  },
  async loadRooms() {
    try {
      const raw = await callApi('rooms');
      const map = {};
      (raw || []).forEach((r) => { const no = String(r.room_no || r.id); map[no] = r; });
      const mRooms = Object.keys(ROOMS).map((no) => {
        const r = map[no] || {};
        const intro = r.intro ? r.intro.replace(/<[^>]+>/g, '').trim().slice(0, 42) : '';
        return {
          no,
          name: ROOMS[no],
          cover: r.cover || (r.env_photos && r.env_photos[0]) || '',
          intro,
        };
      });
      this.setData({ mRooms });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  openRoomEdit(e) {
    const no = e.currentTarget.dataset.no;
    wx.navigateTo({ url: '/pages/roomEdit/roomEdit?room=' + no });
  },
  switchMerchant(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.renderMerchant();
  },
  switchOrderSub(e) {
    this.setData({ orderSub: e.currentTarget.dataset.sub });
    this.renderMOrders();
  },
  gotoKitchen() {
    wx.navigateTo({ url: '/pages/kitchen/kitchen' });
  },

  /* 订单：订餐菜品 / 现场下单菜品 */
  renderMOrders() {
    if (this.data.orderSub === 'book') this.loadBookings();
    else this.loadLiveOrders();
  },
  async loadLiveOrders() {
    try {
      const raw = await getMerchantOrders();
      const all = (raw || []).map(decorateOrder);
      const mOrders = all.filter((o) => !o.closed);
      const mClosed = all.filter((o) => o.closed).slice(0, 20); // 最近 20 笔已清台，作历史归档
      this.setData({ mOrders, mClosed });
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
  // 一键结账：选支付方式后直接清台（支付+开收据+closed 一步到位，消除两步法口径分裂）
  async settleOrder(e) {
    const id = e.currentTarget.dataset.id;
    const method = await new Promise((res) => wx.showActionSheet({
      itemList: ['现金', '扫码', '记账'],
      success: (r) => res(['cash', 'scan', 'credit'][r.tapIndex]),
      fail: () => res(''),
    }));
    if (!method) return;
    wx.showLoading({ title: '结账中' });
    try { await clearOrder(id, method); this.renderMOrders(); wx.showToast({ title: '已结清', icon: 'success' }); }
    catch (err) { wx.showToast({ title: '操作失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },
  // 兼容：对已进入「已支付未清台」状态的订单二次清台确认（正常流程一键结账后用不到，保留防历史脏数据）
  async clearOrder(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((res) => wx.showModal({
      title: '清台确认', content: '确认清台？该订单将从当前列表移除，但记录在「已清台」归档中可查。',
      success: (r) => res(r.confirm),
    }));
    if (!ok) return;
    wx.showLoading({ title: '处理中' });
    try { await clearOrder(id); this.renderMOrders(); }
    catch (err) { wx.showToast({ title: '操作失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },
  toggleClosed() { this.setData({ showClosed: !this.data.showClosed }); },

  /* 菜品 */
  async renderMDishes() {
    try {
      const raw = await getDishesAdmin();
      this.setData({
        mDishes: (raw || []).map((d) => ({ ...d, priceText: fmt(d.price), ph: (d.name || '?').charAt(0), portions: d.portions || {} })),
      });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    let edit;
    if (id === '__new__') {
      edit = { name: '', category: CATS[0], price: '', image: '', description: '', specs: [], tags: [], soldOut: false, limited: false, portions: [] };
    } else {
      const d = this.data.mDishes.find((x) => x.id === id);
      const known = ['招牌', '辣', '素', '时令'];
      const rawPortions = (d.portions && typeof d.portions === 'object' && !Array.isArray(d.portions)) ? d.portions : {};
      const portions = Object.keys(rawPortions).map((k) => ({ mat: k, amt: String(rawPortions[k]) }));
      edit = { name: d.name, category: d.category, price: String(d.price), image: d.image || '', description: d.description || '', specs: d.specs || [], tags: (d.tags || []).filter((t) => known.indexOf(t) >= 0), soldOut: !!d.soldOut, limited: !!d.limited, portions };
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
  onSoldOutToggle() { this.setData({ 'edit.soldOut': !this.data.edit.soldOut }); },
  onLimitedToggle() { this.setData({ 'edit.limited': !this.data.edit.limited }); },
  /* 每份用料编辑（结论 #D：食材采购清单数据源） */
  addPortion() {
    const portions = this.data.edit.portions.concat([{ mat: '', amt: '' }]);
    this.setData({ 'edit.portions': portions });
  },
  onPortion(e) {
    const { pi, f } = e.currentTarget.dataset;
    this.setData({ ['edit.portions[' + pi + '].' + f]: e.detail.value });
  },
  removePortion(e) {
    const pi = e.currentTarget.dataset.pi;
    const portions = this.data.edit.portions.slice();
    portions.splice(pi, 1);
    this.setData({ 'edit.portions': portions });
  },
  closeEdit() { this.setData({ showEdit: false }); },
  async saveDish() {
    const ed = this.data.edit;
    if (!ed.name || !ed.name.trim()) { wx.showToast({ title: '请填写菜名', icon: 'none' }); return; }
    // 每份用料：行数组 → {材料: 用量数值}
    const portions = {};
    (ed.portions || []).forEach((p) => {
      const m = (p.mat || '').trim();
      const a = Number(p.amt) || 0;
      if (m && a > 0) portions[m] = a;
    });
    const payload = {
      name: ed.name.trim(), category: ed.category,
      price: Number(ed.price) || 0, image: ed.image || '',
      description: ed.description || '', specs: ed.specs || [],
      tags: ed.tags || [], available: true,
      soldOut: !!ed.soldOut, limited: !!ed.limited,
      portions,
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
  // 列表上快速切换：今日售罄 / 今日限定
  async toggleSoldOut(e) {
    const id = e.currentTarget.dataset.id;
    const d = this.data.mDishes.find((x) => x.id === id);
    if (!d) return;
    wx.showLoading({ title: '处理中' });
    try {
      await saveDish(id, {
        name: d.name, category: d.category, price: d.price, image: d.image || '',
        description: d.description || '', specs: d.specs || [], tags: d.tags || [],
        soldOut: !d.soldOut, limited: !!d.limited,
      });
      this.renderMDishes();
    } catch (err) { wx.showToast({ title: '操作失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },
  async toggleLimited(e) {
    const id = e.currentTarget.dataset.id;
    const d = this.data.mDishes.find((x) => x.id === id);
    if (!d) return;
    wx.showLoading({ title: '处理中' });
    try {
      await saveDish(id, {
        name: d.name, category: d.category, price: d.price, image: d.image || '',
        description: d.description || '', specs: d.specs || [], tags: d.tags || [],
        soldOut: !!d.soldOut, limited: !d.limited,
      });
      this.renderMDishes();
    } catch (err) { wx.showToast({ title: '操作失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },

  /* 报表 */
  setRep(e) { this.setData({ repMode: e.currentTarget.dataset.mode }); this.renderReport(); },
  onRepDate(e) { this.setData({ repDate: e.detail.value }); this.renderReport(); },
  async renderReport() {
    if (this.data.repMode === 'receipt') { this.renderReceipts(); return; }
    try {
      const raw = await getMerchantOrders();
      // 报表口径：以「已结清（closed）」为准，与收据列表一致，避免含未清台订单导致对账差
      const paid = (raw || []).filter((o) => o.closed);
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
  /* 电子收据列表（结论 #E） */
  async renderReceipts() {
    try {
      const list = await listReceipts();
      this.setData({
        mReceipts: (list || []).map((r) => ({
          ...r,
          totalText: fmt(r.total),
          pmText: ({ cash: '现金', scan: '扫码', credit: '记账' })[r.paymentMethod] || r.paymentMethod,
          paidText: r.paid ? '已支付' : '未支付',
          invText: r.invoiced ? '已开票' : '未开票',
          lines: (r.lines || []).map((it) => ({
            ...it, unitText: fmt(it.unitPrice), subText: fmt(it.subtotal),
          })),
        })),
      });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  openReceipt(e) {
    const id = e.currentTarget.dataset.id;
    const r = this.data.mReceipts.find((x) => x.id === id);
    if (r) this.setData({ receiptDetail: r });
  },
  closeReceipt() { this.setData({ receiptDetail: false }); },

  /* 老板工具：补发提醒 / 清零售罄（结论 #3 / #18尾） */
  async pushReminders() {
    wx.showLoading({ title: '补发中' });
    try {
      const res = await pushReminders();
      wx.hideLoading();
      wx.showToast({ title: '已补发 ' + (res.sent || 0) + ' 条', icon: 'none' });
    } catch (e) { wx.hideLoading(); wx.showToast({ title: '失败', icon: 'none' }); }
  },
  async resetDailyFlags() {
    const ok = await new Promise((res) => wx.showModal({
      title: '清零售罄', content: '将清除全部菜品的「今日售罄 / 今日限定」标记（每日开门应做的操作）。确定？',
      success: (r) => res(r.confirm),
    }));
    if (!ok) return;
    wx.showLoading({ title: '重置中' });
    try {
      const res = await resetDailyFlags();
      wx.hideLoading();
      wx.showToast({ title: '已重置 ' + (res.reset || 0) + ' 道', icon: 'none' });
      this.renderMDishes();
    } catch (e) { wx.hideLoading(); wx.showToast({ title: '失败', icon: 'none' }); }
  },
  // 老板工具：清理过期 pending 申请（创建超 24h 仍未处理的预订标记为已取消）
  async sweepPending() {
    const ok = await new Promise((res) => wx.showModal({
      title: '清理过期申请', content: '将把创建超过 24 小时仍未处理的预订申请标记为已取消。确定？',
      success: (r) => res(r.confirm),
    }));
    if (!ok) return;
    wx.showLoading({ title: '清理中' });
    try {
      const res = await sweepPending();
      wx.hideLoading();
      wx.showToast({ title: '已清理 ' + (res.cancelled || 0) + ' 条', icon: 'none' });
      this.renderMOrders();
    } catch (e) { wx.hideLoading(); wx.showToast({ title: '失败', icon: 'none' }); }
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
