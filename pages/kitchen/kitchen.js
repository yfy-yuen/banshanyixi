// 后厨配菜单（第19条 · 零硬件屏幕出单方案）
// 纯前端聚合：bookings(type=meal, 含预点菜快照) + merchantOrders(未清台现场单)
// 支持「日期切换」(日历/今天明天后天) + 「餐段筛选」(全天/午市/晚市)；未来日期仅含预点菜。
// 按包厢分组出餐单；按菜名汇总配菜总份数。不依赖任何新云函数，不卡部署。
const { ROOMS } = require('../../utils/config');
const { callApi, getMerchantOrders, getDishesAdmin } = require('../../utils/api');
const { detectTablet } = require('../../utils/tablet');

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
    isTablet: false,
    role: '', noPerm: false,
    date: '', chips: [], slot: 'all', // slot: all | lunch | dinner
    view: 'kitchen', // kitchen 后厨出餐单 | summary 配菜汇总 | procure 食材采购清单
    rooms: [], summary: [], totalQty: 0, loaded: false, empty: false,
    procure: [], futureHint: false,
    kmExtras: [],        // 后厨手工补充项 [{name,qty,note}]（来自 kitchenManual 集合）
    qtyOverride: {},     // 数量覆盖 {菜名: 份数}（只影响配菜单显示与采购，不动客人订单）
    autoQtyMap: {},      // 系统自动份数 {菜名: 份数}（编辑数量时展示"系统份数"作参考）
    manualDlg: { show: false, mode: 'add', name: '', qty: '1', unit: '', note: '', isManual: false, autoQty: 0 },
  },
  
  onLoad() {
    this.setData({ isTablet: detectTablet() });
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
      const [bkRaw, ordRaw, dishRaw, kmRaw] = await Promise.all([
        callApi('bookings'),
        getMerchantOrders(),
        getDishesAdmin(),
        callApi('getKitchenManual', { date: today, slot }).catch(() => null),
      ]);
      const kmExtras = (kmRaw && Array.isArray(kmRaw.extras)) ? kmRaw.extras : [];
      const kmOverride = (kmRaw && kmRaw.qtyOverride && typeof kmRaw.qtyOverride === 'object' && !Array.isArray(kmRaw.qtyOverride)) ? kmRaw.qtyOverride : {};
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
      const autoQtyMap = {};

      bookings.forEach((b) => {
        const r = ensure(b.room_id);
        (b.dishes || []).forEach((d) => {
          const name = (d.name || '').trim();
          if (!name) return;
          const qty = Number(d.qty) || 1;
          r.pre.push({ name, qty, note: (d.note || '').trim() });
          sumMap[name] = (sumMap[name] || 0) + qty;
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
        });
        const on = (o.note || '').trim();
        if (on && r.orderNotes.indexOf(on) < 0) r.orderNotes.push(on);
      });
      Object.keys(sumMap).forEach((k) => { autoQtyMap[k] = sumMap[k]; });

      const rooms = Object.values(byRoom).sort((a, b) => Number(a.no) - Number(b.no));
      rooms.forEach((r) => { r.orderNotes = r.orderNotes.join('；'); });

      // 套用数量覆盖（kmOverride）：只影响配菜单显示与采购反算，绝不动客人订单
      const baseQty = {};
      Object.keys(sumMap).forEach((name) => {
        const q = kmOverride[name] !== undefined ? Number(kmOverride[name]) : sumMap[name];
        if (q > 0) baseQty[name] = q;
      });

      // 食材采购：按「覆盖后份数」× 每份用料 反算（手工补充项无配方，不参与）
      const materialMap = {};
      Object.keys(baseQty).forEach((name) => {
        const ps = dishPortions[name] || {};
        Object.keys(ps).forEach((mat) => {
          materialMap[mat] = (materialMap[mat] || 0) + baseQty[name] * (Number(ps[mat]) || 0);
        });
      });

      // 配菜汇总 = 覆盖后的菜品 + 手工补充项（✋ 标记）
      const summary = Object.keys(baseQty).map((name) => ({ key: 'd:' + name, name, qty: baseQty[name], manual: false }));
      (kmExtras || []).forEach((x) => {
        const nm = (x.name || '').trim();
        if (!nm) return;
        const unit = (x.unit || '').trim().slice(0, 8); // 保留用户填的单位，别再 fallback 成"份"
        const ex = summary.find((s) => s.manual && s.name === nm);
        if (ex) {
          ex.qty += Number(x.qty) || 1;
          if (unit) ex.unit = unit;
        } else summary.push({ key: 'm:' + nm, name: nm, qty: Number(x.qty) || 1, unit, manual: true, note: (x.note || '').trim() });
      });
      summary.sort((a, b) => b.qty - a.qty);
      const totalQty = summary.reduce((s, x) => s + x.qty, 0);
      const procure = Object.keys(materialMap)
        .map((mat) => ({ mat, total: materialMap[mat] }))
        .sort((a, b) => b.total - a.total);
      this.setData({
        rooms, summary, totalQty, procure,
        kmExtras, qtyOverride: kmOverride, autoQtyMap,
        loaded: true,
        empty: rooms.length === 0,
        futureHint: today > todayStr(),
      });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
  onPullDownRefresh() { this.loadData(); wx.stopPullDownRefresh(); },
  refresh() { this.loadData(); },

  /* ===== 配菜汇总：手工补充项 + 数量修改 ===== */
  noop() {},
  // 「＋手动添加」弹窗
  openManual() {
    this.setData({ manualDlg: { show: true, mode: 'add', name: '', qty: '1', unit: '份', note: '', isManual: false, autoQty: 0 } });
  },
  // 点某行数量 → 编辑（菜：套 qtyOverride；手工项：直接改 extras 数量）
  openQtyEdit(e) {
    const ds = e.currentTarget.dataset;
    const name = ds.name;
    const isManual = ds.manual;
    const autoQty = isManual ? 0 : (this.data.autoQtyMap[name] || 0);
    // 手工项保留原单位（qty 模式不改单位，单位在添加时确定）
    let curUnit = '';
    if (isManual) {
      const ex = (this.data.kmExtras || []).find((x) => x.name === name);
      curUnit = (ex && ex.unit) || '';
    }
    this.setData({
      manualDlg: {
        show: true, mode: 'qty', name,
        qty: String(ds.qty || 1), unit: curUnit, note: '',
        isManual: !!isManual, autoQty,
      },
    });
  },
  onDlgInput(e) {
    const f = e.currentTarget.dataset.f;
    this.setData({ ['manualDlg.' + f]: e.detail.value });
  },
  closeManual() { this.setData({ 'manualDlg.show': false }); },
  // 保存（新增手工项 / 改数量），落库后整体刷新
  async saveManual() {
    const dlg = this.data.manualDlg;
    // 数量支持小数（如 0.5 把葱花），最少 0.01，保留 2 位
    const parseQty = () => Math.max(0.01, Math.round((Number(dlg.qty) || 1) * 100) / 100);
    if (dlg.mode === 'add') {
      const name = (dlg.name || '').trim();
      if (!name) { wx.showToast({ title: '请填写名称', icon: 'none' }); return; }
      const qty = parseQty();
      const unit = (dlg.unit || '份').trim().slice(0, 8);
      const note = (dlg.note || '').trim();
      const extras = this.data.kmExtras.slice();
      const ex = extras.find((x) => x.name === name);
      if (ex) {
        ex.qty = Math.round((ex.qty + qty) * 100) / 100;
        if (unit) ex.unit = unit;
        if (note) ex.note = note;
      } else extras.push({ name, qty, unit, note });
      await this.saveKitchenManual(extras, this.data.qtyOverride);
    } else {
      const name = dlg.name;
      const qty = parseQty();
      if (dlg.isManual) {
        const extras = this.data.kmExtras.slice();
        const ex = extras.find((x) => x.name === name);
        if (ex) ex.qty = qty;
        await this.saveKitchenManual(extras, this.data.qtyOverride);
      } else {
        const ov = Object.assign({}, this.data.qtyOverride);
        ov[name] = qty;
        await this.saveKitchenManual(this.data.kmExtras, ov);
      }
    }
  },
  // 单位快捷按钮（点选填入 manualDlg.unit）
  pickUnit(e) {
    this.setData({ 'manualDlg.unit': e.currentTarget.dataset.u });
  },
  // 删除手工补充项
  async removeExtra(e) {
    const name = e.currentTarget.dataset.name;
    const ok = await new Promise((res) => wx.showModal({
      title: '删除手工项', content: '删除「' + name + '」？', success: (r) => res(r.confirm),
    }));
    if (!ok) return;
    const extras = this.data.kmExtras.filter((x) => x.name !== name);
    await this.saveKitchenManual(extras, this.data.qtyOverride);
  },
  // 统一落库 + 刷新
  async saveKitchenManual(extras, qtyOverride) {
    wx.showLoading({ title: '保存中' });
    try {
      await callApi('saveKitchenManual', { date: this.data.date, slot: this.data.slot, extras, qtyOverride });
      this.setData({ 'manualDlg.show': false });
      await this.loadData();
    } catch (e) {
      console.error('[kitchen] saveKitchenManual', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  screenshotTip() {
    wx.showModal({
      title: '如何出单',
      content: '当前为屏幕出单：直接截图本页，或用手机/平板投屏到厨房；需要纸质时把截图发到电脑打印即可。后续可接入蓝牙/云打印机自动出小票。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
