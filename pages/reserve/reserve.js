const { ROOMS } = require('../../utils/config');
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
    form: { date: '', mealTime: 'lunch', partySize: 2, contactPhone: '', note: '' },
    submitting: false,
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selectedKey: 'reserve' });
    }
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
        // 店务确认后会自动排席并生成 booking（reservationRef 回指），这里显示顾客被安排在几号包厢
        roomText: r.roomId ? (ROOMS[r.roomId] || (r.roomId + ' 号包厢')) : '',
      }));
      this.setData({ mine });
    } catch (e) { console.warn('[reserve]', e); }
    this.setData({ loading: false });
  },

  /* 申请订位弹窗（不再依赖场次，顾客自选日期/餐段直接提交） */
  openApply() {
    this.setData({ showApply: true, form: { date: todayStr(), mealTime: 'lunch', partySize: 2, contactPhone: '', note: '' } });
  },
  closeApply() { this.setData({ showApply: false }); },
  noop() {},
  onDate(e) { this.setData({ 'form.date': e.detail.value }); },
  onMeal(e) { this.setData({ 'form.mealTime': e.currentTarget.dataset.meal }); },
  onParty(e) { this.setData({ 'form.partySize': Math.max(1, parseInt(e.detail.value) || 1) }); },
  onPhone(e) { this.setData({ 'form.contactPhone': e.detail.value }); },
  onNote(e) { this.setData({ 'form.note': e.detail.value }); },
  async submit() {
    const { form } = this.data;
    if (!form.date) { wx.showToast({ title: '请选择日期', icon: 'none' }); return; }
    if (!form.partySize || form.partySize < 1) { wx.showToast({ title: '请填写人数', icon: 'none' }); return; }
    if (!/^1[3-9]\d{9}$/.test(form.contactPhone)) { wx.showToast({ title: '请填写正确手机号', icon: 'none' }); return; }
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中' });
    try {
      await submitReservation({
        date: form.date, mealTime: form.mealTime,
        partySize: form.partySize, contactPhone: form.contactPhone, note: form.note,
      });
      wx.hideLoading();
      this.setData({ submitting: false, showApply: false });
      wx.showToast({ title: '已提交订位申请，等待确认', icon: 'none' });
      this.refresh();
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
    }
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
