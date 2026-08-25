// 后厨配菜单（第19条 · 零硬件屏幕出单方案）
// 纯前端聚合：bookings(type=meal, 含预点菜快照) + merchantOrders(未清台现场单)
// 支持「日期切换」(日历/今天明天后天) + 「餐段筛选」(全天/午市/晚市)；未来日期仅含预点菜。
// 按包厢分组出餐单；按菜名汇总配菜总份数。不依赖任何新云函数，不卡部署。
const { ROOMS } = require('../../utils/config');
const { callApi, getMerchantOrders, getDishesAdmin } = require('../../utils/api');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
// 由时间戳(ISO)推算北京餐段：<14 点午市，否则晚市
function slotOfTs(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const bh = (d.getUTCHours() + 8) % 24;
  return bh < 14 ? 'lunch' : 'dinner';
}

Page({
  data: {
    role: '', noPerm: false,
    date: '', chips: [], slot: 'all', // slot: all | lunch | dinner
    view: 'kitchen', // kitchen 后厨出餐单 | summary 配菜汇总 | procure 食材采购清单
    rooms: [], summary: [], totalQty: 0, loaded: false, empty: false,
    procure: [], futureHint: false,
  },
  onShow() {
    const app = getApp();
    const role = app.globalData.role;
    if (!role) { app.refreshRole().then(() => this.onShow()); return; }
    const isStaff = role === 'clerk' || role === 'manager';
    if (!isStaff) { this.setData({ noPerm: true }); return; }
    const today = todayStr();
    // 进入页面默认选中今天；已选过其他日期则保留（切视图/切餐段不会重置）
    this.setData({
      noPerm: false,
      date: this.data.date || today,
      chips: [
        { label: '今天', date: today },
        { label: '明天', date: addDays(1) },
        { label: '后天', date: addDays(2) },
      ],
    });
    this.loadData();
  },
  switchView(e) { this.setData({ view: e.currentTarget.dataset.view }); },
  // 日期切换：原生日历选择器
  onDatePick(e) { this.setData({ date: e.detail.value }); this.loadData(); },
  // 日期切换：今天/明天/后天快捷胶囊
  pickChip(e) { this.setData({ date: e.currentTarget.dataset.date }); this.loadData(); },
  // 餐段筛选：全天 / 午市 / 晚市
  switchSlot(e) { this.setData({ slot: e.currentTarget.dataset.slot }); this.loadData(); },
  async loadData() {
    wx.showLoading({ title: '加载中' });
    try {
      const today = this.data.date;
      const slot = this.data.slot;
      const [bkRaw, ordRaw, dishRaw] = await Promise.all([
        callApi('bookings'),
        getMerchantOrders(),
        getDishesAdmin(),
      ]);
      // 预点菜：按选中日期 + 餐段（b.slot 已是午/晚）；未来日期自然无现场单
      const bookings = (bkRaw || []).filter((b) =>
        b.type === 'meal' && b.date === today && (b.dishes || []).length &&
        (slot === 'all' || b.slot === slot));
      // 现场单：按选中日期；选了具体餐段时按创建时间北京时段过滤（未来日期 created_at 不在该日→为空）
      const orders = (ordRaw || []).filter((o) =>
        !o.closed && (o.created_at || '').slice(0, 10) === today &&
        (slot === 'all' || slotOfTs(o.created_at) === slot));

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
      this.setData({ rooms, summary, totalQty, procure, loaded: true, empty: rooms.length === 0, futureHint: today > todayStr() });
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
