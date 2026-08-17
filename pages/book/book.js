const { ROOMS } = require('../../utils/config');
const { callApi, getDishesAdmin, listReservations, confirmReservation, rejectReservation, publishSession, closeSession, sessionsAdmin } = require('../../utils/api');
const app = getApp();

function pad(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function mealText(m) { return m === 'dinner' ? '晚市' : '午市'; }
// 棋牌分午间/晚间；用餐分午/晚
function bookingLabel(b) {
  if (b.type === 'game') return b.slot === 'lunch' ? '午间棋牌' : '晚间棋牌';
  return b.slot === 'lunch' ? '午餐订餐' : '晚餐订餐';
}

Page({
  data: {
    role: '', uid: '', noPerm: false, isManager: false,
    year: 2026, month: 8, cells: [], selected: '',
    rooms: [], dishes: [],
    matrix: {},
    applications: [],
    sessions: [],
    showModal: false, showPub: false,
    form: { roomNo: '', roomName: '', slot: 'lunch', type: 'meal', dishIds: [], guest_name: '', guest_phone: '', note: '', date: '', id: null },
    pub: { date: '', mealTime: 'lunch', capacity: '', note: '' },
  },
  onLoad() {
    const now = new Date();
    this.setData({
      year: now.getFullYear(), month: now.getMonth() + 1, selected: todayStr(),
      rooms: Object.entries(ROOMS).map(([no, name]) => ({ no, name })),
    });
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selectedKey: 'book' });
    }
    const app = getApp();
    const role = app.globalData.role;
    if (role === '') { app.refreshRole().then(() => this.onShow()); return; }
    this.setData({ role, uid: app.globalData.uid, isManager: role === 'manager' });
    if (role !== 'clerk' && role !== 'manager') { this.setData({ noPerm: true }); return; }
    this.setData({ noPerm: false });
    this.buildMonth(this.data.year, this.data.month);
    this.loadDishes();
    this.loadMatrix(this.data.selected);
    this.loadApplications();
    this.loadSessions();
  },
  buildMonth(y, m) {
    const first = new Date(y, m - 1, 1);
    const startWeek = first.getDay();
    const dim = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < startWeek; i++) cells.push({ empty: true });
    for (let d = 1; d <= dim; d++) {
      const ds = y + '-' + pad(m) + '-' + pad(d);
      cells.push({ day: d, dateStr: ds, isSel: ds === this.data.selected });
    }
    this.setData({ cells });
  },
  prevMonth() {
    let { year, month } = this.data; month--;
    if (month < 1) { month = 12; year--; }
    this.setData({ year, month }); this.buildMonth(year, month);
  },
  nextMonth() {
    let { year, month } = this.data; month++;
    if (month > 12) { month = 1; year++; }
    this.setData({ year, month }); this.buildMonth(year, month);
  },
  pickDay(e) {
    const ds = e.currentTarget.dataset.date;
    if (!ds) return;
    this.setData({ selected: ds });
    this.buildMonth(this.data.year, this.data.month);
    this.loadMatrix(ds);
  },
  async loadDishes() {
    try { const dishes = await getDishesAdmin(); this.setData({ dishes: dishes || [] }); }
    catch (e) { console.warn('[book] dishes', e); }
  },
  async loadMatrix(dateStr) {
    try {
      const list = (await callApi('bookings', { date: dateStr })) || [];
      const matrix = {};
      this.data.rooms.forEach((rm) => { matrix[rm.no] = { lunch: null, dinner: null }; });
      list.forEach((x) => { if (matrix[x.room_id]) matrix[x.room_id][x.slot] = x; });
      this.setData({ matrix });
    } catch (e) { console.warn('[book] matrix', e); }
  },
  openCell(e) {
    const { room, slot } = e.currentTarget.dataset;
    const roomName = (this.data.rooms.find((r) => r.no === room) || {}).name || room;
    const existing = this.data.matrix[room] && this.data.matrix[room][slot];
    if (existing) {
      wx.showToast({ title: '该餐段已排：' + bookingLabel(existing), icon: 'none' });
      return;
    }
    this.setData({
      showModal: true,
      form: { roomNo: room, roomName, slot, type: 'meal', dishIds: [], guest_name: '', guest_phone: '', note: '', date: this.data.selected, id: null },
    });
  },
  // 改期：打开弹窗并回填
  editBooking(e) {
    const { room, slot } = e.currentTarget.dataset;
    const b = this.data.matrix[room] && this.data.matrix[room][slot];
    if (!b) return;
    const roomName = (this.data.rooms.find((r) => r.no === room) || {}).name || room;
    const dishIds = (b.dishes || []).map((d) => d.dish_id).filter(Boolean);
    this.setData({
      showModal: true,
      form: {
        roomNo: room, roomName, slot: b.slot, type: b.type, dishIds,
        guest_name: b.guest_name || '', guest_phone: b.guest_phone || '', note: b.note || '',
        date: b.date, id: b.id,
      },
    });
  },
  closeModal() { this.setData({ showModal: false }); },
  noop() {},
  setType(e) { this.setData({ 'form.type': e.currentTarget.dataset.type }); },
  setSlot(e) { this.setData({ 'form.slot': e.currentTarget.dataset.slot }); },
  onDate(e) { this.setData({ 'form.date': e.detail.value }); },
  toggleDish(e) {
    const id = e.currentTarget.dataset.id;
    const arr = this.data.form.dishIds.slice();
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
    this.setData({ 'form.dishIds': arr });
  },
  onField(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  // 取消预定
  async cancelBooking(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((res) => wx.showModal({ title: '取消预定', content: '确定取消该排席？', success: (r) => res(r.confirm) }));
    if (!ok) return;
    wx.showLoading({ title: '取消中' });
    try {
      await callApi('deleteBooking', { id });
      wx.hideLoading();
      this.setData({ showModal: false });
      this.loadMatrix(this.data.selected);
      wx.showToast({ title: '已取消', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '取消失败', icon: 'none' });
    }
  },
  async save() {
    const f = this.data.form;
    if (f.type === 'meal' && !f.dishIds.length) { wx.showToast({ title: '请至少选择一道菜', icon: 'none' }); return; }
    if (!f.date) { wx.showToast({ title: '请选择日期', icon: 'none' }); return; }
    const dishes = f.dishIds.map((id) => {
      const d = this.data.dishes.find((x) => x.id === id);
      return { dish_id: id, name: d.name, image: d.image, qty: 1, note: '' };
    });
    wx.showLoading({ title: '保存中' });
    try {
      if (f.id) {
        // 改期/改餐段：冲突校验（排除自身）
        const exist = await callApi('bookings', { date: f.date });
        const clash = (exist || []).find((x) => x.room_id === f.roomNo && x.slot === f.slot && String(x.id) !== String(f.id));
        if (clash) {
          wx.hideLoading();
          wx.showModal({ title: '冲突', content: '该包厢此日期餐段已排：' + bookingLabel(clash), showCancel: false });
          return;
        }
        await callApi('saveBooking', {
          id: f.id,
          booking: {
            date: f.date, slot: f.slot, type: f.type,
            dishes, guest_name: f.guest_name, guest_phone: f.guest_phone, note: f.note,
          },
        });
      } else {
        await callApi('saveBooking', {
          booking: {
            room_id: f.roomNo, date: f.date, slot: f.slot, type: f.type,
            dishes, guest_name: f.guest_name, guest_phone: f.guest_phone, note: f.note,
          },
        });
      }
      wx.hideLoading();
      this.setData({ showModal: false });
      this.loadMatrix(this.data.selected);
      wx.showToast({ title: f.id ? '已改期' : '已排定', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '保存失败', content: String((err && err.message) || err).slice(0, 300), showCancel: false });
    }
  },
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
  // 顾客自助预订申请：列出待确认项供老板/店员审批
  async loadApplications() {
    try {
      const list = (await listReservations()) || [];
      const apps = list.filter((r) => r.status === 'pending').map((r) => ({
        id: r.id, partySize: r.partySize, contactPhone: r.contactPhone, note: r.note || '',
        date: (r.session && r.session.date) || '', meal: mealText((r.session && r.session.mealTime) || 'lunch'),
      }));
      this.setData({ applications: apps });
    } catch (e) { console.warn('[book] applications', e); }
  },
  async confirmApp(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showLoading({ title: '确认中' });
    try {
      const res = await confirmReservation(id);
      wx.hideLoading();
      this.loadApplications();
      this.loadMatrix(this.data.selected);
      const tip = res && res.needManualAssign ? '已确认，包厢已满请手动排席' : '已确认并自动排席';
      wx.showToast({ title: tip, icon: 'none' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '失败', icon: 'none' });
    }
  },
  async rejectApp(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showLoading({ title: '婉拒中' });
    try { await rejectReservation(id); wx.hideLoading(); this.loadApplications(); this.loadMatrix(this.data.selected); wx.showToast({ title: '已婉拒', icon: 'none' }); }
    catch (err) { wx.hideLoading(); wx.showToast({ title: (err && err.message) || '失败', icon: 'none' }); }
  },

  /* ===== 发席 / 关场（开放顾客订位） ===== */
  async loadSessions() {
    try { const list = await sessionsAdmin(); this.setData({ sessions: list || [] }); }
    catch (e) { console.warn('[book] sessions', e); }
  },
  openPublish() {
    this.setData({ showPub: true, pub: { date: this.data.selected, mealTime: 'lunch', capacity: '', note: '' } });
  },
  closePub() { this.setData({ showPub: false }); },
  onPubDate(e) { this.setData({ 'pub.date': e.detail.value }); },
  setPubMeal(e) { this.setData({ 'pub.mealTime': e.currentTarget.dataset.meal }); },
  onPubInput(e) { this.setData({ ['pub.' + e.currentTarget.dataset.field]: e.detail.value }); },
  async savePub() {
    const f = this.data.pub;
    if (!f.date) { wx.showToast({ title: '请选择日期', icon: 'none' }); return; }
    const cap = Number(f.capacity);
    if (!cap || cap < 1) { wx.showToast({ title: '请填写有效座位上限', icon: 'none' }); return; }
    wx.showLoading({ title: '发席中' });
    try {
      await publishSession({ date: f.date, mealTime: f.mealTime, capacity: cap, note: f.note || '' });
      wx.hideLoading();
      this.setData({ showPub: false });
      this.loadSessions();
      wx.showToast({ title: '已发席，顾客端可订', icon: 'none' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '发席失败', icon: 'none' });
    }
  },
  async closeSession(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const ok = await new Promise((res) => wx.showModal({ title: '关场', content: '关闭后顾客将无法预订该场次，确定？', success: (r) => res(r.confirm) }));
    if (!ok) return;
    wx.showLoading({ title: '关闭中' });
    try { await closeSession(id); wx.hideLoading(); this.loadSessions(); wx.showToast({ title: '已关场', icon: 'success' }); }
    catch (err) { wx.hideLoading(); wx.showToast({ title: (err && err.message) || '失败', icon: 'none' }); }
  },
});
