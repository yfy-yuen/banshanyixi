const { CATS, fmt, ROOMS } = require('../../../utils/config');
const { detectTablet } = require('../../../utils/tablet');
const {
  getMerchantOrders, settleOrder, clearOrder, setOrderItemPrice, listReceipts, pushReminders, resetDailyFlags, getDishesAdmin, saveDish, batchSetPrices, deleteDish, getPaymentQrcodes, saveQr, callApi, sweepPending,
} = require('../../../utils/api');

// 云函数读出的 serverDate 经 JSON 序列化是 UTC ISO，直接切字符串会比北京时间慢 8 小时；
// 仅在带明确时区的 ISO 串上做 +8h 换算，老数据里的本地格式串保持原样。
function bjTimeText(v) {
  const s = String(v || '');
  if (!s) return '—';
  if (/T\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (isFinite(t)) {
      const d = new Date(t + 8 * 3600 * 1000);
      const p = (n) => (n < 10 ? '0' + n : '' + n);
      return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
    }
  }
  return s.replace('T', ' ').slice(5, 16) || '—';
}

function decorateOrder(o) {
  const items = (o.items || []).map((i) => ({
    ...i,
    selText: i.sel && Object.keys(i.sel).length ? '（' + Object.values(i.sel).join('/') + '）' : '',
    // 时价菜：下单时标记待定价，或菜品库为 market 且尚未由店员定价
    pricePending: i.pricePending === true || (i.pricing === 'market' && !i.priced),
    unitText: fmt(i.unitPrice || 0),
  }));
  return {
    ...o, items, totalText: fmt(o.total),
    pendingCount: items.filter((i) => i.pricePending).length,
    paidText: o.status === 'paid' ? '已支付' : '未支付',
    createdText: String(o.created_at || '').replace('T', ' ').slice(0, 16),
    timeText: bjTimeText(o.created_at),
    noteText: (o.note || '').trim(),
  };
}

// 棋牌分午间/晚间；用餐分午/晚
function bookingLabel(b) {
  if (b.type === 'game') return b.slot === 'lunch' ? '午间棋牌' : '晚间棋牌';
  return b.slot === 'lunch' ? '午餐订餐' : '晚餐订餐';
}

/* ===== 订单分组与折叠（2026-11-17）=====
   只重组前端渲染结构，不写库、不改金额、不改结账逻辑。
   mOrders / mBookings / mClosed 原数组一律保留（openPrice / openPriceAdd 仍从 mOrders 取单）。 */
function bjDateStr(offsetDays) {
  return new Date(Date.now() + 8 * 3600 * 1000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}
function dateTextOf(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return date || '未定日期';
  const w = ['日', '一', '二', '三', '四', '五', '六'][new Date(date + 'T12:00:00Z').getUTCDay()];
  return date.slice(5) + ' 周' + w;
}
// 现场单按包厢分组；待定价的急单默认展开，其余只露一行
function buildOrderGroups(orders) {
  const map = {}, keys = [];
  (orders || []).forEach((o) => {
    const key = 'r' + (o.room_no || o.room_name || 'other');
    if (!map[key]) {
      map[key] = {
        key, roomNo: o.room_no || '', roomName: o.room_name || ('包厢 ' + (o.room_no || '')),
        count: 0, total: 0, collapsed: false, orders: [],
      };
      keys.push(key);
    }
    const g = map[key];
    g.count += 1;
    g.total += Number(o.total) || 0;
    g.orders.push({ ...o, expanded: !!o.pendingCount });
  });
  return keys.map((k) => map[k])
    .sort((a, b) => (Number(a.roomNo) || 999) - (Number(b.roomNo) || 999))
    .map((g) => ({ ...g, totalText: fmt(g.total) }));
}
// 订餐排期按日期分组；只默认展开今天 / 明天，午市排在晚市前
function buildBookingGroups(bookings) {
  const map = {}, keys = [];
  (bookings || []).forEach((b) => {
    const key = b.date || '未定日期';
    if (!map[key]) {
      map[key] = { key, date: key, dateText: dateTextOf(key), count: 0, collapsed: true, items: [] };
      keys.push(key);
    }
    map[key].count += 1;
    map[key].items.push(b);
  });
  const today = bjDateStr(0), tomorrow = bjDateStr(1);
  return keys.sort().map((k) => {
    const g = map[k];
    g.collapsed = !(k === today || k === tomorrow);
    g.items.sort((a, b) => (a.slot === 'dinner' ? 1 : 0) - (b.slot === 'dinner' ? 1 : 0));
    g.dateText = (k === today ? '今天 · ' : k === tomorrow ? '明天 · ' : '') + g.dateText;
    return g;
  });
}
// 已清台按日期归档（最近日期在前）；外层「已清台」总开关仍负责整体收起
function buildClosedGroups(orders) {
  const map = {}, keys = [];
  (orders || []).forEach((o) => {
    const raw = String(o.created_at || '');
    const key = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '早期';
    if (!map[key]) {
      map[key] = { key, date: key, dateText: dateTextOf(key), count: 0, total: 0, collapsed: false, items: [] };
      keys.push(key);
    }
    const g = map[key];
    g.count += 1;
    g.total += Number(o.total) || 0;
    g.items.push(o);
  });
  return keys.sort((a, b) => {
    if (a === '早期') return 1;
    if (b === '早期') return -1;
    return b.localeCompare(a);
  }).map((k) => ({ ...map[k], totalText: fmt(map[k].total) }));
}

/* ===== 订单筛选（D 2026-11-17）：纯前端本地过滤，作用于已加载数据的副本 =====
   云端 dataApi 零改动；mOrders / mBookings / mClosed 原数组一律保留，
   因为 openPrice / openPriceAdd 仍按 id 从 mOrders 取单。 */
function filterActive(f) {
  return !!(f && (f.room || (f.status && f.status !== 'all') || String(f.kw || '').trim()));
}
function bookFilterActive(f) {
  return !!(f && ((f.date && f.date !== 'all') || f.room || (f.slot && f.slot !== 'all') || String(f.kw || '').trim()));
}
// 现场单 / 已清台共用：包厢、状态、关键字（菜名 / 包厢 / 备注 / 时间 / 单号）
function filterLiveOrders(list, f) {
  const kw = String((f && f.kw) || '').trim().toLowerCase();
  return (list || []).filter((o) => {
    if (f.room && String(o.room_no || '') !== String(f.room)) return false;
    if (f.status === 'unpaid' && o.status === 'paid') return false;
    if (f.status === 'paid' && o.status !== 'paid') return false;
    if (f.status === 'pending' && !(o.pendingCount > 0)) return false;
    if (kw) {
      const hay = [o.room_name, o.room_no, o.timeText, o.note, o.id,
        (o.items || []).map((i) => (i.name || '') + (i.selText || '')).join(' ')].join(' ').toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}
// 订餐排期：日期（今天 / 明天 / 近 7 天）、包厢、餐段、关键字（尊客 / 菜名 / 包厢 / 日期）
function filterBookings(list, f) {
  const kw = String((f && f.kw) || '').trim().toLowerCase();
  const today = bjDateStr(0), tomorrow = bjDateStr(1), week = [];
  for (let i = 0; i < 7; i++) week.push(bjDateStr(i));
  return (list || []).filter((b) => {
    const date = String(b.date || '');
    if (f.date === 'today' && date !== today) return false;
    if (f.date === 'tomorrow' && date !== tomorrow) return false;
    if (f.date === 'week' && week.indexOf(date) < 0) return false;
    if (f.room && String(b.room_id || '') !== String(f.room)) return false;
    if (f.slot && f.slot !== 'all' && b.slot !== f.slot) return false;
    if (kw) {
      const hay = [b.date, b.roomName, b.label, b.guestText, b.dishList, b.slot].join(' ').toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}
function roomOptions(list) {
  const set = {};
  (list || []).forEach((o) => { const n = String(o.room_no || ''); if (n) set[n] = 1; });
  return Object.keys(set).sort((a, b) => (Number(a) || 999) - (Number(b) || 999));
}
function bookRoomOptions(list, roomMap) {
  const set = {};
  (list || []).forEach((b) => { const n = String(b.room_id || ''); if (n) set[n] = (roomMap && roomMap[n]) || n; });
  return Object.keys(set).sort((a, b) => (Number(a) || 999) - (Number(b) || 999))
    .map((no) => ({ no, name: set[no] }));
}

// 商家后台共享核心：5 个 tab 拆成 5 个独立分包页面，全部 Page 复用本对象
// 各页面只需覆盖 data.tab，即可复用下面全部方法与数据
module.exports = {
  data: {
    isTablet: false,
    role: '', isManager: false, isStaff: false, noPerm: false,
    tab: 'orders',
    orderSub: 'book',
    mOrders: [], mBookings: [], mDishes: [],
    mClosed: [], showClosed: false,
    // 订单分组 / 折叠：只控制渲染，原数组保留供定价弹窗取单
    orderGroups: [], bookingGroups: [], closedGroups: [],
    // 订单筛选（D 2026-11-17）：纯视图层，筛选后重算分组，原数组不动
    ordRoom: '', ordStatus: 'all', ordKw: '', ordRooms: [],
    ordTotal: 0, ordHit: 0, closedHit: 0, hasOrdFilter: false,
    bkDate: 'all', bkRoom: '', bkSlot: 'all', bkKw: '', bkRooms: [],
    bkTotal: 0, bkHit: 0, hasBkFilter: false,
    repMode: 'day', repDate: '', repRows: [], repTotalText: '', repCount: 0,
    mReceipts: [], receiptDetail: false,
    qrMap: {},
    showEdit: false, editId: '__new__', edit: null, cats: CATS, catsIndex: 0,
    // 时价菜定价弹窗：priceMode = price（给已有项定价）| add（追加时价项）
    showPrice: false, priceMode: 'price', priceOrderId: '', priceOrderItems: [], priceIdx: 0,
    priceForm: { name: '', unitPrice: '', qty: '1' },
    tagOptions: ['招牌', '辣', '素', '时令'],
    staffList: [], requests: [],
    mView: 'dishes',   // 菜品 tab 内的子视图：dishes 菜品 | price 今日时价 | rooms 包厢
    mRooms: [],
    marketRows: [],    // 今日时价快改行：{ id, name, category, priceInput }
    // 菜品管理筛选（2026-09-26 借鉴菜单页的分类/搜索 UX）
    filterCat: '',         // ''=全部；否则等于菜品 category
    filterStatus: 'all',   // 'all'|'on'|'soldOut'|'limited'
    filterKw: '',          // 关键字（菜名/标签/描述）
    showDishSearch: false,
    dishCats: [],          // 当前已有菜品覆盖到的 CATS 分类列表
    dishSections: [],      // 按 category 分组的菜品（渲染主列表用）
    dishSearchResults: [], // 关键字搜索结果（搜索面板里用）
  },
  onLoad() {
    this.setData({ isTablet: detectTablet() });
    // 按北京时间取默认报表日期，避免 UTC 口径在北京 0–8 点错一天
    this.setData({ repDate: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) });
  },
  onShow() {
    // 分包页不显示自定义 tabBar，页内提供「返回店务」按钮
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
  // 从分包后台回到主包「店务」tab（switchTab 会清掉分包页栈）
  goBackBook() {
    wx.switchTab({ url: '/pages/book/book' });
  },
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
    // 店员仅可访问订单页；直接输路径进其它页时踢回订单页，避免数据与视图错位
    if (!tabs.find((t) => t[0] === this.data.tab)) {
      wx.redirectTo({ url: '/staff/pages/merchant/orders/orders' });
      return;
    }
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
    else if (this.data.mView === 'price') this.loadMarketPrices();
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
    wx.navigateTo({ url: '/staff/pages/roomEdit/roomEdit?room=' + no });
  },
  // 5 个 tab 已拆成 5 个独立分包页面：同层 redirectTo 切换，不堆页面栈
  switchMerchant(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) return;
    wx.redirectTo({ url: '/staff/pages/merchant/' + tab + '/' + tab });
  },
  switchOrderSub(e) {
    this.setData({ orderSub: e.currentTarget.dataset.sub });
    this.renderMOrders();
  },
  gotoKitchen() {
    wx.navigateTo({ url: '/staff/pages/kitchen/kitchen' });
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
      const mClosed = all.filter((o) => o.closed); // 全量归档，按日期分组后由总开关收起，不再硬截 20 笔
      this.setData({ mOrders, mClosed, ordRooms: roomOptions(mOrders) });
      this.applyOrderFilter();
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  // 只过滤副本后重算分组：mOrders / mClosed 原数组保持完整，定价弹窗仍按 id 取单
  applyOrderFilter() {
    const f = { room: this.data.ordRoom, status: this.data.ordStatus, kw: this.data.ordKw };
    const live = filterLiveOrders(this.data.mOrders, f);
    const closed = filterLiveOrders(this.data.mClosed, f);
    this.setData({
      orderGroups: buildOrderGroups(live),
      closedGroups: buildClosedGroups(closed),
      ordTotal: (this.data.mOrders || []).length,
      ordHit: live.length, closedHit: closed.length,
      hasOrdFilter: filterActive(f),
    });
  },
  async loadBookings() {
    try {
      const b = await callApi('bookings');
      const mBookings = (b || []).map((x) => ({
        ...x,
        roomName: ROOMS[x.room_id] || x.room_id,
        label: bookingLabel(x),
        dishList: (x.dishes || []).map((d) => d.name + ' ×' + (d.qty || 1)).join('、') || '—',
        guestText: x.guest_name ? ('尊客' + x.guest_name + (x.guest_phone ? ' ' + x.guest_phone : '')) : '—',
      }));
      this.setData({ mBookings, bkRooms: bookRoomOptions(mBookings, ROOMS) });
      this.applyBookingFilter();
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  applyBookingFilter() {
    const f = { date: this.data.bkDate, room: this.data.bkRoom, slot: this.data.bkSlot, kw: this.data.bkKw };
    const list = filterBookings(this.data.mBookings, f);
    const groups = buildBookingGroups(list);
    // 有筛选时命中的日期组全部展开，否则筛出来了还收着等于没筛
    if (bookFilterActive(f)) groups.forEach((g) => { g.collapsed = false; });
    this.setData({
      bookingGroups: groups,
      bkTotal: (this.data.mBookings || []).length,
      bkHit: list.length, hasBkFilter: bookFilterActive(f),
    });
  },
  setOrdRoom(e) { this.setData({ ordRoom: e.currentTarget.dataset.v || '' }); this.applyOrderFilter(); },
  setOrdStatus(e) { this.setData({ ordStatus: e.currentTarget.dataset.v || 'all' }); this.applyOrderFilter(); },
  onOrdKwInput(e) { this.setData({ ordKw: e.detail.value || '' }); this.applyOrderFilter(); },
  clearOrderFilter() {
    this.setData({ ordRoom: '', ordStatus: 'all', ordKw: '' });
    this.applyOrderFilter();
  },
  setBkDate(e) { this.setData({ bkDate: e.currentTarget.dataset.v || 'all' }); this.applyBookingFilter(); },
  setBkRoom(e) { this.setData({ bkRoom: e.currentTarget.dataset.v || '' }); this.applyBookingFilter(); },
  setBkSlot(e) { this.setData({ bkSlot: e.currentTarget.dataset.v || 'all' }); this.applyBookingFilter(); },
  onBkKwInput(e) { this.setData({ bkKw: e.detail.value || '' }); this.applyBookingFilter(); },
  clearBookFilter() {
    this.setData({ bkDate: 'all', bkRoom: '', bkSlot: 'all', bkKw: '' });
    this.applyBookingFilter();
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
    catch (err) { wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' }); }
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
    catch (err) { wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },
  toggleClosed() { this.setData({ showClosed: !this.data.showClosed }); },
  // 折叠只改对应下标的布尔值，避免整组 setData 冲掉其它展开状态
  toggleOrderGroup(e) {
    const i = Number(e.currentTarget.dataset.gi);
    const g = (this.data.orderGroups || [])[i];
    if (!g) return;
    const d = {}; d['orderGroups[' + i + '].collapsed'] = !g.collapsed;
    this.setData(d);
  },
  toggleOrderCard(e) {
    const gi = Number(e.currentTarget.dataset.gi), oi = Number(e.currentTarget.dataset.oi);
    const g = (this.data.orderGroups || [])[gi];
    const o = g && (g.orders || [])[oi];
    if (!o) return;
    const d = {}; d['orderGroups[' + gi + '].orders[' + oi + '].expanded'] = !o.expanded;
    this.setData(d);
  },
  toggleBookingGroup(e) {
    const i = Number(e.currentTarget.dataset.gi);
    const g = (this.data.bookingGroups || [])[i];
    if (!g) return;
    const d = {}; d['bookingGroups[' + i + '].collapsed'] = !g.collapsed;
    this.setData(d);
  },
  toggleClosedGroup(e) {
    const i = Number(e.currentTarget.dataset.gi);
    const g = (this.data.closedGroups || [])[i];
    if (!g) return;
    const d = {}; d['closedGroups[' + i + '].collapsed'] = !g.collapsed;
    this.setData(d);
  },

  /* 时价菜：定价 / 追加时价项（2026-11-16） */
  openPrice(e) {
    const id = e.currentTarget.dataset.id;
    const o = (this.data.mOrders || []).find((x) => x.id === id);
    if (!o) return;
    const items = (o.items || []).map((i, idx) => ({ ...i, idx }));
    const first = items.find((i) => i.pricePending);
    this.setData({
      showPrice: true, priceMode: 'price', priceOrderId: id,
      priceOrderItems: items, priceIdx: first ? first.idx : 0,
      priceForm: { name: '', unitPrice: '', qty: '1' },
    });
  },
  openPriceAdd(e) {
    const id = e.currentTarget.dataset.id;
    const o = (this.data.mOrders || []).find((x) => x.id === id);
    if (!o) return;
    this.setData({
      showPrice: true, priceMode: 'add', priceOrderId: id,
      priceOrderItems: (o.items || []).map((i, idx) => ({ ...i, idx })), priceIdx: 0,
      priceForm: { name: '', unitPrice: '', qty: '1' },
    });
  },
  pickPriceItem(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const it = (this.data.priceOrderItems || []).find((x) => x.idx === idx);
    this.setData({
      priceIdx: idx,
      'priceForm.unitPrice': it && !it.pricePending && Number(it.unitPrice) > 0 ? String(it.unitPrice) : '',
    });
  },
  onPriceInput(e) {
    const f = e.currentTarget.dataset.field;
    this.setData({ ['priceForm.' + f]: e.detail.value });
  },
  closePrice() { this.setData({ showPrice: false }); },
  async savePrice() {
    const f = this.data.priceForm || {};
    const unit = Number(f.unitPrice);
    if (!f.unitPrice || !isFinite(unit) || unit <= 0) { wx.showToast({ title: '请填写大于 0 的单价', icon: 'none' }); return; }
    const payload = {
      id: this.data.priceOrderId,
      mode: this.data.priceMode,
      itemIndex: this.data.priceIdx,
      unitPrice: unit,
      name: (f.name || '').trim(),
      qty: Number(f.qty) || 1,
    };
    if (this.data.priceMode === 'add' && !payload.name) { wx.showToast({ title: '请填写菜名', icon: 'none' }); return; }
    wx.showLoading({ title: '保存中' });
    try {
      await setOrderItemPrice(payload);
      this.setData({ showPrice: false });
      this.renderMOrders();
      wx.showToast({ title: '已定价，合计已更新', icon: 'success' });
    } catch (err) { wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },

  /* 菜品 */
  async renderMDishes() {
    try {
      const raw = await getDishesAdmin();
      this.setData({
        mDishes: (raw || []).map((d) => ({
          ...d, priceText: fmt(d.price), isMarket: d.pricing === 'market' || !(Number(d.price) > 0),
          ph: (d.name || '?').charAt(0), portions: d.portions || {},
        })),
      });
      this.runDishFilter();
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  // 按当前筛选条件（分类/状态/关键字）重算 dishSections 与 dishSearchResults
  runDishFilter() {
    const all = this.data.mDishes || [];
    // 已用到的分类（chips）
    const dishCats = CATS.filter((c) => all.some((d) => d.category === c));
    let list = all.slice();
    if (this.data.filterCat) list = list.filter((d) => d.category === this.data.filterCat);
    if (this.data.filterStatus === 'on') list = list.filter((d) => !d.soldOut);
    else if (this.data.filterStatus === 'soldOut') list = list.filter((d) => !!d.soldOut);
    else if (this.data.filterStatus === 'limited') list = list.filter((d) => !!d.limited);
    const kw = (this.data.filterKw || '').trim().toLowerCase();
    if (kw) {
      list = list.filter((d) =>
        (d.name || '').toLowerCase().includes(kw) ||
        (d.tags || []).join(',').toLowerCase().includes(kw) ||
        (d.description || '').toLowerCase().includes(kw)
      );
    }
    // 有关键字 → 单组展示「搜索结果」；否则按分类分组（与菜单页一致）
    let dishSections;
    if (kw) {
      dishSections = [{ cat: '搜索结果', items: list }];
    } else {
      const present = CATS.filter((c) => list.some((d) => d.category === c));
      dishSections = present.map((cat) => ({ cat, items: list.filter((d) => d.category === cat) }));
    }
    this.setData({ dishCats, dishSections, dishSearchResults: list });
  },
  setDishCat(e) {
    this.setData({ filterCat: e.currentTarget.dataset.cat || '' });
    this.runDishFilter();
  },
  setDishStatus(e) {
    this.setData({ filterStatus: e.currentTarget.dataset.st || 'all' });
    this.runDishFilter();
  },
  openDishSearch() { this.setData({ showDishSearch: true }); },
  closeDishSearch() {
    this.setData({ showDishSearch: false, filterKw: '' });
    this.runDishFilter();
  },
  onDishKwInput(e) {
    this.setData({ filterKw: e.detail.value || '' });
    this.runDishFilter();
  },
  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    let edit;
    if (id === '__new__') {
      edit = { name: '', category: CATS[0], price: '', image: '', description: '', specs: [], tags: [], soldOut: false, limited: false, pricing: 'fixed', portions: [] };
    } else {
      const d = this.data.mDishes.find((x) => x.id === id);
      const known = ['招牌', '辣', '素', '时令'];
      const rawPortions = (d.portions && typeof d.portions === 'object' && !Array.isArray(d.portions)) ? d.portions : {};
      const portions = Object.keys(rawPortions).map((k) => ({ mat: k, amt: String(rawPortions[k]) }));
      edit = { name: d.name, category: d.category, price: String(d.price), image: d.image || '', description: d.description || '', specs: d.specs || [], tags: (d.tags || []).filter((t) => known.indexOf(t) >= 0), soldOut: !!d.soldOut, limited: !!d.limited, pricing: d.pricing === 'market' ? 'market' : 'fixed', portions };
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
  onPricingToggle() { this.setData({ 'edit.pricing': this.data.edit.pricing === 'market' ? 'fixed' : 'market' }); },
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
  // 菜品图：相册选图 → 上传云存储 → 自动回填 cloud:// 地址（无需手动填 URL）
  async pickDishImage() {
    const r = await new Promise((res) => wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'], success: res, fail: res,
    }));
    if (!r || !r.tempFiles || !r.tempFiles[0]) return;
    wx.showLoading({ title: '上传中' });
    try {
      const f = r.tempFiles[0];
      const ext = (f.tempFilePath.split('.').pop() || 'jpg').split('?')[0];
      const cloudPath = `dishes/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath });
      if (up && up.fileID) {
        this.setData({ 'edit.image': up.fileID });
        wx.showToast({ title: '图片已选好', icon: 'success' });
      } else {
        wx.showToast({ title: '上传失败，请重试', icon: 'none' });
      }
    } catch (e) {
      console.error('[merchant] upload dish image fail', e);
      wx.showToast({ title: '上传失败，请重试', icon: 'none' });
    } finally { wx.hideLoading(); }
  },
  clearDishImage() {
    this.setData({ 'edit.image': '' });
  },
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
      pricing: ed.pricing === 'market' ? 'market' : 'fixed',
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
        pricing: d.pricing === 'market' ? 'market' : 'fixed',
        // 必须带上原 portions：云函数里是 portions: d.portions || {}，
        // 不传就会被覆盖成空 {}，导致该菜「每份用料」被清空、食材采购清单算不出来
        portions: d.portions || {},
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
        pricing: d.pricing === 'market' ? 'market' : 'fixed',
        // 同上：必须带上原 portions，否则会被云函数覆盖成空 {} 清空每份用料
        portions: d.portions || {},
      });
      this.renderMDishes();
    } catch (err) { wx.showToast({ title: '操作失败', icon: 'none' }); }
    finally { wx.hideLoading(); }
  },

  /* 今日时价：一屏批量改价（2026-11-17） */
  async loadMarketPrices() {
    try {
      const raw = await getDishesAdmin();
      const rows = (raw || [])
        .filter((d) => d.pricing === 'market' || !(Number(d.price) > 0))
        .map((d) => ({
          id: d.id, name: d.name, category: d.category || '',
          priceInput: Number(d.price) > 0 ? String(d.price) : '',
        }));
      this.setData({ marketRows: rows });
    } catch (e) { wx.showToast({ title: '加载失败', icon: 'none' }); }
  },
  onMarketPriceInput(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ ['marketRows[' + idx + '].priceInput']: e.detail.value });
  },
  async saveMarketPrices() {
    const rows = this.data.marketRows || [];
    const prices = [];
    for (const r of rows) {
      const v = String(r.priceInput == null ? '' : r.priceInput).trim();
      if (v === '') { prices.push({ id: r.id, price: 0 }); continue; }
      const n = Number(v);
      if (!isFinite(n) || n < 0) { wx.showToast({ title: '「' + r.name + '」价格不合法', icon: 'none' }); return; }
      prices.push({ id: r.id, price: n });
    }
    wx.showLoading({ title: '保存中' });
    let ok = false, updated = 0, msg = '';
    try {
      const r = await batchSetPrices(prices);
      ok = true; updated = r.updated || 0;
      this.loadMarketPrices();
    } catch (err) { msg = (err && err.message) || '保存失败'; }
    wx.hideLoading();
    wx.showToast({ title: ok ? ('已更新 ' + updated + ' 道') : msg, icon: ok ? 'success' : 'none' });
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
};
