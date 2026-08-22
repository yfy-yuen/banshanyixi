const { ROOMS } = require('../../utils/config');
const { callApi, getDishesAdmin, listReservations, confirmReservation, rejectReservation, publishSession, closeSession, sessionsAdmin, updateReservationDishes } = require('../../utils/api');
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
    showModal: false, showPub: false, showPublishFeature: false,
    form: { roomNo: '', roomName: '', slot: 'lunch', type: 'meal', dishIds: [], guest_name: '', guest_phone: '', note: '', date: '', id: null },
    pub: { date: '', mealTime: 'lunch', capacity: '', note: '' },
    confirmed: [],
    showPre: false, preForm: { id: null, roomText: '', dishes: [] },
    dishCount: {},
    showDetail: false,
    detail: { roomNo: '', roomName: '', slot: '', slotText: '', type: '', typeText: '', label: '', guest_name: '', guest_phone: '', partySize: 0, dishes: [], note: '', id: '' },
    showAddDish: false, addDishForm: { id: '', dishIds: [] },
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
    this.loadConfirmed();
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
      // 点击已占用格子打开详情卡片
      this.setData({
        showDetail: true,
        detail: {
          roomNo: room, roomName, slot,
          slotText: slot === 'lunch' ? '午餐' : '晚餐',
          type: existing.type || 'meal',
          typeText: (existing.type || 'meal') === 'game' ? '棋牌' : '用餐',
          label: bookingLabel(existing),
          guest_name: existing.guest_name || '',
          guest_phone: existing.guest_phone || '',
          partySize: existing.partySize || 0,
          dishes: (existing.dishes || []).map((d) => ({ name: d.name || '', qty: d.qty || 1 })),
          note: existing.note || '',
          id: existing.id || '',
        },
      });
      return;
    }
    this.setData({
      showModal: true,
      form: { roomNo: room, roomName, slot, type: 'meal', dishIds: [], guest_name: '', guest_phone: '', note: '', date: this.data.selected, id: null },
    });
  },
  closeDetail() { this.setData({ showDetail: false }); },
  // 详情页点改期：二次确认后打开编辑弹窗
  async doEditFromDetail() {
    const d = this.data.detail;
    if (!d.id) return;
    const ok = await new Promise((res) => wx.showModal({
      title: '确认改期', content: '是否改期该排席？', success: (r) => res(r.confirm),
    }));
    if (!ok) return;
    this.closeDetail();
    const b = this.data.matrix[d.roomNo] && this.data.matrix[d.roomNo][d.slot];
    if (!b) return;
    const dishIds = (b.dishes || []).map((x) => x.dish_id).filter(Boolean);
    this.setData({
      showModal: true,
      form: {
        roomNo: d.roomNo, roomName: d.roomName, slot: b.slot, type: b.type, dishIds,
        guest_name: b.guest_name || '', guest_phone: b.guest_phone || '', note: b.note || '',
        date: b.date, id: b.id,
      },
    });
  },
  // 详情页点取消：二次确认后执行
  async doCancelFromDetail() {
    const d = this.data.detail;
    if (!d.id) return;
    const ok = await new Promise((res) => wx.showModal({
      title: '确认取消', content: '确定取消该排席？', success: (r) => res(r.confirm),
    }));
    if (!ok) return;
    this.closeDetail();
    await this.cancelBooking(d.id);
  },
  // 详情页点加菜：打开菜品选择面板
  doAddDishFromDetail() {
    this.setData({
      showAddDish: true,
      addDishForm: { id: this.data.detail.id, dishIds: [] },
    });
  },
  closeAddDish() { this.setData({ showAddDish: false }); },
  toggleAddDish(e) {
    const id = e.currentTarget.dataset.id;
    const arr = this.data.addDishForm.dishIds.slice();
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
    this.setData({ 'addDishForm.dishIds': arr });
  },
  async saveAddDish() {
    const { id, dishIds } = this.data.addDishForm;
    if (!id || !dishIds.length) { wx.showToast({ title: '请至少选择一道菜', icon: 'none' }); return; }
    const additions = dishIds.map((did) => {
      const d = this.data.dishes.find((x) => x.id === did);
      return { dish_id: did, name: d.name, image: d.image || '', qty: 1, note: '', sel: '' };
    });
    wx.showLoading({ title: '加菜中' });
    try {
      await callApi('appendBookingDishes', { id, dishes: additions });
      wx.hideLoading();
      this.setData({ showAddDish: false });
      // 刷新排席矩阵和详情数据
      await this.loadMatrix(this.data.selected);
      const d = this.data.detail;
      const b = this.data.matrix[d.roomNo] && this.data.matrix[d.roomNo][d.slot];
      if (b) {
        this.setData({
          'detail.dishes': (b.dishes || []).map((x) => ({ name: x.name || '', qty: x.qty || 1 })),
        });
      }
      wx.showToast({ title: '已加 ' + additions.length + ' 道菜', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '加菜失败', icon: 'none' });
    }
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
  // 取消预定（支持从事件或字符串 id 调用）
  async cancelBooking(e) {
    const id = (typeof e === 'string') ? e : (e.currentTarget && e.currentTarget.dataset.id);
    if (!id) return;
    wx.showLoading({ title: '取消中' });
    try {
      await callApi('deleteBooking', { id });
      wx.hideLoading();
      this.setData({ showModal: false, showDetail: false });
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
        date: r.date || '', meal: mealText(r.mealTime || 'lunch'),
      }));
      this.setData({ applications: apps });
    } catch (e) { console.warn('[book] applications', e); }
  },
  // 已确认/到店预订：供商家改预点菜（结论 #5）
  async loadConfirmed() {
    try {
      const list = (await listReservations()) || [];
      const cs = list
        .filter((r) => r.status === 'confirmed' || r.status === 'arrived' || r.status === 'pending_manual')
        .map((r) => ({
          id: r.id,
          date: r.date || '',
          meal: mealText(r.mealTime || 'lunch'),
          roomText: r.roomId ? (ROOMS[r.roomId] || (r.roomId + ' 号包厢')) : (r.roomNo ? (ROOMS[r.roomNo] || (r.roomNo + ' 号包厢')) : ''),
          partySize: r.partySize || 0,
          dishes: (r.dishes || []).map((d) => ({ dish_id: d.dish_id || '', name: d.name, qty: d.qty || 1, sel: d.sel || '', note: d.note || '' })),
          dishCount: (r.dishes || []).reduce((s, d) => s + (d.qty || 1), 0),
        }));
      this.setData({ confirmed: cs });
    } catch (e) { console.warn('[book] confirmed', e); }
  },
  // 商家打开改预点弹窗（结论 #5）
  openPre(e) {
    const id = e.currentTarget.dataset.id;
    const item = (this.data.confirmed || []).find((c) => c.id === id);
    if (!item) return;
    // 构建以菜名为键的计数映射，便于加减
    const dishCount = {};
    (item.dishes || []).forEach((d) => { dishCount[d.name] = (dishCount[d.name] || 0) + (d.qty || 1); });
    this.setData({
      showPre: true,
      preForm: { id, roomText: item.roomText, dishes: item.dishes.slice() },
      dishCount,
    });
  },
  closePre() { this.setData({ showPre: false }); },
  // 改预点：加减某道菜数量
  changePre(e) {
    const name = e.currentTarget.dataset.name;
    const delta = Number(e.currentTarget.dataset.delta) || 0;
    const dishCount = Object.assign({}, this.data.dishCount);
    const cur = dishCount[name] || 0;
    const next = Math.max(0, cur + delta);
    if (next === 0) delete dishCount[name]; else dishCount[name] = next;
    // 同步 preForm.dishes
    const dishes = this.data.preForm.dishes.slice();
    const idx = dishes.findIndex((d) => d.name === name);
    if (next === 0) {
      if (idx >= 0) dishes.splice(idx, 1);
    } else {
      const orig = idx >= 0 ? dishes[idx] : (() => {
        const found = (this.data.dishes || []).find((x) => x.name === name);
        return { dish_id: found ? found.id : '', name, qty: 0, sel: '', note: '' };
      })();
      orig.qty = next;
      if (idx >= 0) dishes[idx] = orig; else dishes.push(orig);
    }
    this.setData({ dishCount, 'preForm.dishes': dishes });
  },
  async savePre() {
    const id = this.data.preForm.id;
    if (!id) return;
    const dishes = (this.data.preForm.dishes || [])
      .filter((d) => (d.qty || 0) > 0)
      .map((d) => ({ dish_id: d.dish_id || '', name: d.name, qty: d.qty || 1, sel: d.sel || '', note: d.note || '' }));
    wx.showLoading({ title: '保存中' });
    try {
      await updateReservationDishes(id, dishes);
      wx.hideLoading();
      this.setData({ showPre: false });
      this.loadConfirmed();
      wx.showToast({ title: '已更新预点', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },
  async confirmApp(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) { wx.showToast({ title: '缺少预订ID', icon: 'none' }); return; }
    wx.showLoading({ title: '确认中' });
    try {
      // 先确认并拿到云端自动分配的包厢（结论 #H/#10）
      const res = await confirmReservation(id);
      wx.hideLoading();
      this.loadApplications();
      this.loadMatrix(this.data.selected);
      if (res && res.needManualAssign) {
        wx.showModal({ title: '需人工排席', content: '当前时段包厢已满，已转入「待人工分配」。请在右侧日历为该预订手动安排包厢。', showCancel: false });
        return;
      }
      const autoRoom = res && res.roomId ? String(res.roomId) : '';
      // 商家可手动改厢（结论 #H）：弹窗选择包厢覆盖自动分配
      const rooms = this.data.rooms.slice().sort((a, b) => Number(a.no) - Number(b.no));
      const itemList = rooms.map((r) => (r.no === autoRoom ? r.name + '（已分配）' : r.name));
      const pick = await new Promise((res2) => wx.showActionSheet({
        itemList,
        success: (s) => res2(rooms[s.tapIndex].no),
        fail: () => res2(''),
      }));
      if (!pick || pick === autoRoom) {
        wx.showToast({ title: '已确认 · ' + (autoRoom ? autoRoom + '号包厢' : '排席完成'), icon: 'none' });
        return;
      }
      // 改厢：带 roomId 重新确认
      wx.showLoading({ title: '改厢中' });
      try {
        await confirmReservation(id, pick);
        wx.hideLoading();
        this.loadMatrix(this.data.selected);
        wx.showToast({ title: '已改排至 ' + pick + '号包厢', icon: 'none' });
      } catch (err) {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '改厢失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '失败', icon: 'none' });
    }
  },
  async rejectApp(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 结论 #4：婉拒可填原因（选填）；后端若有空闲厢会自动换厢重排并发成功推送，无厢才记 rejectReason
    const ans = await new Promise((res) => wx.showModal({
      title: '婉拒预订', editable: true, placeholderText: '婉拒原因（选填，将告知顾客）',
      success: (r) => res(r.confirm ? r.content || '' : null),
      fail: () => res(null),
    }));
    if (ans === null) return; // 取消操作
    wx.showLoading({ title: '婉拒中' });
    try {
      const res = await rejectReservation(id, ans);
      wx.hideLoading();
      this.loadApplications();
      this.loadMatrix(this.data.selected);
      if (res && res.data && res.data.swapped) {
        wx.showModal({
          title: '已自动换厢',
          content: '原时段仍有空闲包厢，已为该顾客自动安排 ' + res.data.roomId + ' 号包厢并发短信通知，无需婉拒。',
          showCancel: false,
        });
      } else {
        wx.showToast({ title: '已婉拒', icon: 'none' });
      }
    }
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
