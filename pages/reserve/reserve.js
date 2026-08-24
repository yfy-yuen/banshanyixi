const { ROOMS, ROOM_CAP, ROOM_MAJIANG, RESERVE_TPL_ID, canSelfEditPreorder, STORE_PHONE } = require('../../utils/config');
const { submitReservation, myReservations, cancelReservation } = require('../../utils/api');

// 包厢选择列表：第一项「由店家安排」表示不指定，交给云端自动预匹配
// needMahjong=true 时只列出有麻将机的包厢（满仓/枕山）
function buildRoomOptions(needMahjong) {
  const pool = needMahjong ? ROOM_MAJIANG : Object.keys(ROOMS);
  return [{ no: '', name: '由店家安排', display: '由店家安排' }].concat(
    pool.map((no) => ({
      no, name: ROOMS[no],
      display: `${ROOMS[no]}（${ROOM_CAP[no] || '?'}人）${needMahjong ? ' · 麻将机' : ''}`,
    }))
  );
}

function mealLabel(m) { return m === 'dinner' ? '晚市' : '午市'; }
function statusText(s) {
  return ({ pending: '审核中', confirmed: '已确认', rejected: '已婉拒', cancelled: '已取消' })[s] || s;
}
// 自助取消：状态为 pending/confirmed 且距用餐 ≥ 2 整天才可自助取消；否则只能联系店员。
// 与预点菜截止线（canSelfEditPreorder）保持一致：用餐当天/前 1 天锁定。
function canCancel(s, date) {
  if (s !== 'pending' && s !== 'confirmed') return false;
  return canSelfEditPreorder(date);
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

Page({
  data: {
    mine: [], loading: false,
    showApply: false,
    form: { date: '', expectedArrival: '18:00', partySize: '', contactPhone: '', note: '', roomNo: '', roomName: '由店家安排', needMahjong: false },
    roomOptions: buildRoomOptions(false),
    roomIndex: 0,
    submitting: false,
  },
  onShow() {
    this.refresh();
  },
  async refresh() {
    this.setData({ loading: true });
    try {
      const mineRaw = await myReservations();
      const mine = (mineRaw || []).map((r) => ({
        ...r,
        mealText: mealLabel(r.mealTime),
        statusText: statusText(r.status),
        cancellable: canCancel(r.status, r.date),
        preorderCount: (r.dishes || []).length,
        // 自助改预点：状态为 pending/confirmed 且距用餐 ≥ 2 整天；否则只能联系店员代加
        preorderable: (r.status === 'pending' || r.status === 'confirmed') && canSelfEditPreorder(r.date),
        arrivalText: r.expectedArrival || (r.mealTime === 'dinner' ? '晚市' : '午市'),
        // 店务确认后会自动排席并生成 booking（reservationRef 回指），这里显示顾客被安排在几号包厢
        roomText: r.roomId ? (ROOMS[r.roomId] || (r.roomId + ' 号包厢')) : '',
      }));
      this.setData({ mine });
    } catch (e) { console.warn('[reserve]', e); }
    this.setData({ loading: false });
  },

  /* 申请订位弹窗（不再依赖场次，顾客自选日期/餐段直接提交） */
  openApply() {
    this.setData({ showApply: true, form: { date: todayStr(), expectedArrival: '18:00', partySize: '', contactPhone: '', note: '', roomNo: '', roomName: '由店家安排', needMahjong: false }, roomOptions: buildRoomOptions(false), roomIndex: 0 });
  },
  closeApply() { this.setData({ showApply: false }); },
  noop() {},
  onDate(e) { this.setData({ 'form.date': e.detail.value }); },
  onArrival(e) { this.setData({ 'form.expectedArrival': e.detail.value }); },
  onParty(e) {
    const v = e.detail.value;
    this.setData({ 'form.partySize': v === '' ? '' : Math.max(1, parseInt(v) || 1) });
  },
  onPhone(e) { this.setData({ 'form.contactPhone': e.detail.value }); },
  onNote(e) { this.setData({ 'form.note': e.detail.value }); },
  onMahjong(e) {
    const needMahjong = !!e.detail.value;
    // 切换棋牌：重置偏好包厢选择（避免选到无麻将机的厢），并重建可选包厢列表
    this.setData({
      'form.needMahjong': needMahjong,
      'form.roomNo': '',
      'form.roomName': '由店家安排',
      roomIndex: 0,
      roomOptions: buildRoomOptions(needMahjong),
    });
  },
  onRoom(e) {
    const idx = Number(e.detail.value) || 0;
    const opt = this.data.roomOptions[idx];
    if (!opt) return;
    this.setData({ roomIndex: idx, 'form.roomNo': opt.no, 'form.roomName': opt.name });
  },
  /* 去预点菜（必填，结论 #15 / #G）：
     校验 日期+预计到达时间+人数+手机号 后，把表单草稿交给 menu 预点模式；
     menu 在「完成预点」时一并创建带预点菜的预订（submitReservation）。
     这样订厢必须同时预点，商家审核时即已有预点数据（结论 #15）。 */
  async goPreorder() {
    const { form } = this.data;
    if (!form.date) { wx.showToast({ title: '请选择日期', icon: 'none' }); return; }
    if (!form.expectedArrival) { wx.showToast({ title: '请选择预计到达时间', icon: 'none' }); return; }
    if (!form.partySize || form.partySize < 1) { wx.showToast({ title: '请填写人数', icon: 'none' }); return; }
    if (!/^1[3-9]\d{9}$/.test(form.contactPhone)) { wx.showToast({ title: '请填写正确手机号', icon: 'none' }); return; }

    // 订阅消息授权（顾客端）：必须在用户点击的同步链路内请求，店务确认时云端才能推送
    if (RESERVE_TPL_ID) {
      try { await new Promise((res) => wx.requestSubscribeMessage({ tmplIds: [RESERVE_TPL_ID], success: res, fail: res })); }
      catch (e) { /* 授权失败不影响订位提交 */ }
    }

    // 把表单草稿交给 menu 预点页（menu 创建预订时一并写入预点菜）
    getApp().globalData.preorderDraft = {
      date: form.date, expectedArrival: form.expectedArrival,
      partySize: form.partySize, contactPhone: form.contactPhone, note: form.note,
      roomNo: form.roomNo || '',
      needMahjong: form.needMahjong || false,
    };
    this.setData({ showApply: false });
    wx.navigateTo({ url: '/pages/menu/menu?mode=preorder&create=1' });
  },
  /* 去预点菜（我的订位内，针对已有预订）：直接跳 menu 预点菜模式改/补 */
  editPreorder(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/menu/menu?mode=preorder&reservationId=' + id });
  },
  async cancelMine(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 双保险：即便绕过 UI 直接调用，也按截止线拦截（与预点菜一致）
    const target = (this.data.mine || []).find((r) => r.id === id);
    if (target && !canCancel(target.status, target.date)) {
      wx.showToast({ title: '距用餐不足 2 天，无法自助取消，请联系店员', icon: 'none' });
      return;
    }
    const ok = await new Promise((res) => wx.showModal({
      title: '取消预订', content: '确定取消该预订申请？', success: (r) =>  res(r.confirm),
    }));
    if (!ok) return;
    wx.showLoading({ title: '取消中' });
    try {
      await cancelReservation(id);
      wx.hideLoading();
      wx.showToast({ title: '已取消', icon: 'success' });
      this.refresh();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '取消失败', icon: 'none' });
    }
  },
  mealLabel, statusText, canCancel,
});
