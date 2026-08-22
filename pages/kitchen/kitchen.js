// 后厨配菜单（第19条 · 零硬件屏幕出单方案）
// 纯前端聚合：bookings(type=meal, 今日, 含预点菜快照) + merchantOrders(今日, 未清台现场单)
// 按包厢分组出餐单；按菜名汇总配菜总份数。不依赖任何新云函数，不卡部署。
const { ROOMS } = require('../../utils/config');
const { callApi, getMerchantOrders, getDishesAdmin } = require('../../utils/api');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

Page({
  data: {
    role: '', noPerm: false,
    date: '', view: 'kitchen', // kitchen 后厨出餐单 | summary 配菜汇总 | procure 食材采购清单
    rooms: [], summary: [], totalQty: 0, loaded: false, empty: false,
    procure: [],
  },
  onShow() {
    const app = getApp();
    const role = app.globalData.role;
    if (!role) { app.refreshRole().then(() => this.onShow()); return; }
    const isStaff = role === 'clerk' || role === 'manager';
    if (!isStaff) { this.setData({ noPerm: true }); return; }
    this.setData({ noPerm: false, date: todayStr() });
    this.loadData();
  },
  switchView(e) { this.setData({ view: e.currentTarget.dataset.view }); },
  async loadData() {
    wx.showLoading({ title: '加载中' });
    try {
      const today = this.data.date;
      const [bkRaw, ordRaw, dishRaw] = await Promise.all([
        callApi('bookings'),
        getMerchantOrders(),
        getDishesAdmin(),
      ]);
      const bookings = (bkRaw || []).filter((b) => b.type === 'meal' && b.date === today && (b.dishes || []).length);
      const orders = (ordRaw || []).filter((o) => !o.closed && (o.created_at || '').slice(0, 10) === today);

      // 菜名 → 每份用料字典 {材料: 用量}，供食材采购清单反算（结论 #D）
      const dishPortions = {};
      (dishRaw || []).forEach((d) => {
        const nm = (d.name || '').trim();
        if (nm) dishPortions[nm] = (d.portions && typeof d.portions === 'object' && !Array.isArray(d.portions)) ? d.portions : {};
      });

      const byRoom = {};
      const ensure = (no) => {
        const s = String(no);
        if (!byRoom[s]) byRoom[s] = { no: s, name: ROOMS[s] || (s + '号'), pre: [], live: [], orderNotes: [] };
        return byRoom[s];
      };
      const sumMap = {};
      const materialMap = {};
      const accMat = (name, qty) => {
        const ps = dishPortions[name] || {};
        Object.keys(ps).forEach((mat) => { materialMap[mat] = (materialMap[mat] || 0) + qty * (Number(ps[mat]) || 0); });
      };

      bookings.forEach((b) => {
        const r = ensure(b.room_id);
        (b.dishes || []).forEach((d) => {
          const name = (d.name || '').trim();
          if (!name) return;
          const qty = Number(d.qty) || 1;
          r.pre.push({ name, qty, note: (d.note || '').trim() });
          sumMap[name] = (sumMap[name] || 0) + qty;
          accMat(name, qty);
        });
      });
      orders.forEach((o) => {
        const r = ensure(o.room_no);
        (o.items || []).forEach((it) => {
          const name = (it.name || '').trim();
          if (!name) return;
          const qty = Number(it.qty) || 1;
          const sel = it.sel && Object.keys(it.sel).length ? '（' + Object.values(it.sel).join('/') + '）' : '';
          r.live.push({ name: name + sel, qty });
          sumMap[name] = (sumMap[name] || 0) + qty;
          accMat(name, qty);
        });
        const on = (o.note || '').trim();
        if (on && r.orderNotes.indexOf(on) < 0) r.orderNotes.push(on);
      });

      const rooms = Object.values(byRoom).sort((a, b) => Number(a.no) - Number(b.no));
      rooms.forEach((r) => { r.orderNotes = r.orderNotes.join('；'); });
      const summary = Object.keys(sumMap)
        .map((name) => ({ name, qty: sumMap[name] }))
        .sort((a, b) => b.qty - a.qty);
      const totalQty = summary.reduce((s, x) => s + x.qty, 0);
      const procure = Object.keys(materialMap)
        .map((mat) => ({ mat, total: materialMap[mat] }))
        .sort((a, b) => b.total - a.total);
      this.setData({ rooms, summary, totalQty, procure, loaded: true, empty: rooms.length === 0 });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
  onPullDownRefresh() { this.loadData(); wx.stopPullDownRefresh(); },
  refresh() { this.loadData(); },
  screenshotTip() {
    wx.showModal({
      title: '如何出单',
      content: '当前为屏幕出单：直接截图本页，或用手机/平板投屏到厨房；需要纸质时把截图发到电脑打印即可。后续可接入蓝牙/云打印机自动出小票。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
