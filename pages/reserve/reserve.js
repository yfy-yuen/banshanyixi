const { ROOMS, RESERVE_TPL_ID } = require('../../utils/config');
const { submitReservation, myReservations, cancelReservation } = require('../../utils/api');

function mealLabel(m) { return m === 'dinner' ? '晚市' : '午市'; }
function statusText(s) {
  return ({ pending: '审核中', confirmed: '已确认', rejected: '已婉拒', cancelled: '已取消' })[s] || s;
}
function canCancel(s) { return s === 'pending' || s === 'confirmed'; }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

Page({
  data: {
    mine: [], loading: false,
    showApply: false,
    form: { date: '', expectedArrival: '18:00', partySize: 2, contactPhone: '', note: '' },
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
        cancellable: canCancel(r.status),
        preorderCount: (r.dishes || []).length,
        preorderable: r.status === 'pending' && (r.dishes || []).length === 0,
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
    this.setData({ showApply: true, form: { date: todayStr(), expectedArrival: '18:00', partySize: 2, contactPhone: '', note: '' } });
  },
  closeApply() { this.setData({ showApply: false }); },
  noop() {},
  onDate(e) { this.setData({ 'form.date': e.detail.value }); },
  onArrival(e) { this.setData({ 'form.expectedArrival': e.detail.value }); },
  onParty(e) { this.setData({ 'form.partySize': Math.max(1, parseInt(e.detail.value) || 1) }); },
  onPhone(e) { this.setData({ 'form.contactPhone': e.detail.value }); },
  onNote(e) { this.setData({ 'form.note': e.detail.value }); },
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
    const ok = await new Promise((res) => wx.showModal({
      title: '取消预订', content: '确定取消该预订申请？', success: (r) => res(r.confirm),
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
