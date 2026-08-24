const { CATS, ROOMS, fmt, canSelfEditPreorder, STORE_PHONE } = require('../../utils/config');
const { callApi, loadDishes, submitOrder, getReservation, savePreorder, staffSavePreorder, submitReservation } = require('../../utils/api');
const { classifyError } = require('../../utils/cloudbase');
const app = getApp();

// 徽章：菜品文档 tags 数组 -> 展示元数据；无 tags 时优雅降级（不渲染）
const TAG_META = {
  '招牌': { label: '招牌', cls: 'b-sign' },
  '辣':   { label: '辣',   cls: 'b-spicy' },
  '素':   { label: '素',   cls: 'b-veg' },
  '时令': { label: '时令', cls: 'b-season' },
};

function buildSelText(sel) {
  if (!sel || !Object.keys(sel).length) return '';
  return '（' + Object.values(sel).join('/') + '）';
}

Page({
  data: {
    preorder: false, reservationId: '', locked: false, storePhone: '',
    roomNo: '', roomName: '', people: 1,
    cats: [], sections: [], activeCat: '',
    scrollIntoId: '',
    dishes: [],
    cart: [],
    qtyMap: {},
    cartCount: 0, cartTotalText: '',
    showSpec: false, spec: null,
    showBill: false, bill: null,
    showCart: false, showConfirm: false, note: '',
    showSearch: false, searchKeyword: '', searchResults: [],
    // 店员追加菜品模式（从店务详情进入）
    appendMode: false, appendBookingId: '', appendTargetLabel: '',
    appendTarget: 'booking', appendReservationId: '',
  },
  onLoad(options) {
    if (options.mode === 'append') {
      const target = options.target || 'booking';
      const bookingId = options.bookingId || '';
      const reservationId = options.reservationId || '';
      const appendTargetLabel = options.label || (target === 'reservation' ? '该预订' : '该排席');
      if (target === 'reservation' && !reservationId) {
        wx.showToast({ title: '缺少预订信息', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      if (target === 'booking' && !bookingId) {
        wx.showToast({ title: '缺少排席信息', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      // 改预点：预载顾客已点菜，店员可在真实菜单上加减后整体保存
      if (target === 'reservation') {
        this.setData({
          appendMode: true, appendTarget: target, appendReservationId: reservationId, appendTargetLabel,
          preorder: false,
        });
        this.loadMenu().then(() => this.prefillReservation(reservationId));
        return;
      }
      this.setData({
        appendMode: true, appendTarget: target, appendBookingId: bookingId, appendTargetLabel,
        preorder: false,
      });
      this.loadMenu();
      return;
    }
    if (options.mode === 'preorder') {
      const createMode = options.create === '1';
      this.createMode = createMode;
      this.draft = createMode ? (getApp().globalData.preorderDraft || {}) : null;
      this.setData({ preorder: true, createMode, reservationId: options.reservationId || '', roomNo: '', roomName: '', people: 1 });
      this.initPreorder();
      return;
    }
    let roomNo = options.roomNo || app.globalData.roomNo;
    if (!roomNo) {
      wx.showToast({ title: '请先选择包厢', icon: 'none' });
      setTimeout(() => { wx.switchTab({ url: '/pages/rooms/rooms' }); }, 800);
      return;
    }
    const roomName = ROOMS[roomNo] || '';
    app.globalData.roomNo = roomNo;
    app.globalData.roomName = roomName;
    wx.setStorageSync('roomNo', roomNo);
    wx.setStorageSync('roomName', roomName);
    this.setData({ roomNo, roomName, people: app.globalData.people || 1 });
    this.loadMenu();
  },
  async initPreorder() {
    wx.showLoading({ title: '加载中' });
    try {
      await this.loadMenu();
      // 创建模式：直接选菜即可（表单草稿已在 onLoad 时从 globalData 取好）
      if (this.createMode) { wx.hideLoading(); return; }
      const rid = this.data.reservationId;
      if (rid) {
        const r = await getReservation(rid);
        const dishes = (r && r.dishes) || [];
        // 距用餐不足 2 整天 → 锁定自助改预点，只能联系店员代加（仍可读）
        const locked = !canSelfEditPreorder(r && r.date);
        const cart = dishes.map((d) => {
          const doc = this.data.dishes.find((x) => x.id === d.dish_id);
          return { dishId: d.dish_id, name: d.name, basePrice: doc ? doc.price : 0, category: doc ? doc.category : '', sel: {}, unitPrice: doc ? doc.price : 0, qty: d.qty || 1 };
        }).filter((c) => c.dishId);
        this.updateCart(cart);
        this.setData({
          locked,
          storePhone: (STORE_PHONE || '').split('/')[0] || '',
        });
      }
      wx.hideLoading();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },
  async loadMenu() {
    wx.showLoading({ title: '加载菜单' });
    try {
      const raw = await loadDishes();
      const dishes = raw.map((d) => {
        const tags = d.tags || [];
        const badges = tags.map((t) => TAG_META[t]).filter(Boolean);
        return { ...d, ph: (d.name || '?').charAt(0), badges };
      });
      const present = CATS.filter((c) => dishes.some((d) => d.category === c));
      const sections = present.map((cat) => ({ cat, items: dishes.filter((d) => d.category === cat) }));
      this.setData({ dishes, cats: present, sections, activeCat: present[0] || '' });
      wx.hideLoading();
    } catch (e) {
      console.error('[menu] 菜单加载失败:', e);
      const d = classifyError(e);
      console.warn('[menu] 诊断:', JSON.stringify(d));
      wx.hideLoading();
      const content = String(d.msg).slice(0, 400) + (d.hint ? '\n\n排查建议：\n' + d.hint : '');
      wx.showModal({
        title: '菜单加载失败（' + d.category + '）',
        content,
        confirmText: '重试',
        cancelText: '知道了',
        success: (res) => { if (res.confirm) this.loadMenu(); },
      });
    }
  },
  setCat(e) {
    const cat = e.currentTarget.dataset.cat;
    const idx = this.data.cats.indexOf(cat);
    this.setData({ activeCat: cat, scrollIntoId: 'sec-' + idx });
  },
  onPanelScroll() {
    const query = wx.createSelectorQuery().in(this);
    query.selectAll('.sec').boundingClientRect();
    query.exec((res) => {
      const rects = res[0];
      if (!rects || !rects.length) return;
      let current = this.data.cats[0];
      for (let i = 0; i < rects.length; i++) {
        if (rects[i].top <= 150) current = this.data.cats[i];
      }
      if (current && current !== this.data.activeCat) {
        this.setData({ activeCat: current });
      }
    });
  },
  noop() {},

  /* ===== 搜索 ===== */
  openSearch() { this.setData({ showSearch: true, searchKeyword: '', searchResults: [] }); },
  closeSearch() { this.setData({ showSearch: false, searchKeyword: '', searchResults: [] }); },
  onSearchInput(e) {
    const raw = e.detail.value || '';
    const kw = raw.trim().toLowerCase();
    this.setData({ searchKeyword: raw });
    this.runSearch(kw);
  },
  runSearch(kw) {
    if (!kw) { this.setData({ searchResults: [] }); return; }
    const res = this.data.dishes.filter((d) =>
      (d.name || '').toLowerCase().includes(kw) ||
      (d.tags || []).join(',').toLowerCase().includes(kw) ||
      (d.description || '').toLowerCase().includes(kw)
    );
    this.setData({ searchResults: res });
  },

  /* ===== 购物车 ===== */
  addDish(e) {
    if (this.data.locked) return;
    const id = e.currentTarget.dataset.id;
    const d = this.data.dishes.find((x) => x.id === id);
    if (!d) return;
    if (d.soldOut) { wx.showToast({ title: '该菜已售罄', icon: 'none' }); return; }
    if (d.specs && d.specs.length) { this.openSpec(id); return; }
    this.addToCart({ dishId: id, name: d.name, basePrice: d.price, category: d.category, sel: {}, unitPrice: d.price, qty: 1 });
  },
  decDish(e) {
    if (this.data.locked) return;
    const id = e.currentTarget.dataset.id;
    const cart = this.data.cart.slice();
    let idx = -1;
    for (let i = cart.length - 1; i >= 0; i--) { if (cart[i].dishId === id) { idx = i; break; } }
    if (idx < 0) return;
    if (cart[idx].qty > 1) cart[idx].qty -= 1; else cart.splice(idx, 1);
    this.updateCart(cart);
  },
  addToCart(item) {
    const cart = this.data.cart.slice();
    cart.push(item);
    this.updateCart(cart);
  },
  updateCart(cart) {
    const qtyMap = {};
    let count = 0, total = 0;
    cart.forEach((c) => {
      const q = c.qty || 1;
      qtyMap[c.dishId] = (qtyMap[c.dishId] || 0) + q;
      count += q;
      total += c.unitPrice * q;
    });
    // 按 (dishId + 规格) 分组，供购物篮弹窗展示与编辑
    const gMap = {};
    const gOrder = [];
    cart.forEach((c) => {
      const key = c.dishId + '|' + (buildSelText(c.sel) || '');
      if (!gMap[key]) {
        gMap[key] = { key, dishId: c.dishId, name: c.name, selText: buildSelText(c.sel), unitPrice: c.unitPrice, qty: 0 };
        gOrder.push(key);
      }
      gMap[key].qty += (c.qty || 1);
    });
    const cartGroups = gOrder.map((k) => {
      const g = gMap[k];
      return { ...g, unitPriceText: fmt(g.unitPrice), lineTotal: fmt(g.unitPrice * g.qty) };
    });
    this.setData({ cart, qtyMap, cartCount: count, cartTotalText: fmt(total), cartGroups });
  },

  /* ===== 购物篮 / 确认弹窗 ===== */
  openCart() { if (!this.data.cart.length) return; this.setData({ showCart: true }); },
  closeCart() { this.setData({ showCart: false }); },
  goConfirm() { this.setData({ showCart: false, showConfirm: true }); },
  closeConfirm() { this.setData({ showConfirm: false }); },
  onNoteInput(e) { this.setData({ note: e.detail.value }); },

  // 找到某分组（dishId + 规格）在 cart 中的全部下标
  _idxsOf(key) {
    const out = [];
    this.data.cart.forEach((c, i) => {
      const k = c.dishId + '|' + (buildSelText(c.sel) || '');
      if (k === key) out.push(i);
    });
    return out;
  },
  incCart(e) {
    if (this.data.locked) return;
    const key = e.currentTarget.dataset.key;
    const idxs = this._idxsOf(key);
    if (!idxs.length) return;
    const cart = this.data.cart.slice();
    cart.splice(idxs[0] + 1, 0, { ...cart[idxs[0]] }); // 同规格复制一条 → 数量 +1
    this.updateCart(cart);
  },
  decCart(e) {
    if (this.data.locked) return;
    const key = e.currentTarget.dataset.key;
    const idxs = this._idxsOf(key);
    if (!idxs.length) return;
    const cart = this.data.cart.slice();
    cart.splice(idxs[idxs.length - 1], 1); // 移除该组最后一条 → 数量 -1
    this.updateCart(cart);
  },
  delCart(e) {
    if (this.data.locked) return;
    const key = e.currentTarget.dataset.key;
    const cart = this.data.cart.slice().filter((c) => {
      const k = c.dishId + '|' + (buildSelText(c.sel) || '');
      return k !== key;
    });
    this.updateCart(cart);
  },

  /* ===== 规格 ===== */
  openSpec(id) {
    const d = this.data.dishes.find((x) => x.id === id);
    if (!d) return;
    const picked = {};
    (d.specs || []).forEach((g) => { picked[g.group] = g.options[0] ? g.options[0].label : ''; });
    this.setData({ showSpec: true, spec: this.buildSpec(d, picked, 1) });
  },
  buildSpec(d, picked, qty) {
    let total = d.price;
    (d.specs || []).forEach((g) => {
      const opt = g.options.find((o) => o.label === picked[g.group]);
      if (opt) total += (opt.delta || 0);
    });
    return { dish: d, picked, qty, totalText: fmt(total * qty), groups: d.specs || [] };
  },
  pickSpec(e) {
    const { group, label } = e.currentTarget.dataset;
    const spec = this.data.spec;
    spec.picked[group] = label;
    this.setData({ spec: this.buildSpec(spec.dish, spec.picked, spec.qty) });
  },
  specQty(e) {
    const d = Number(e.currentTarget.dataset.d);
    const spec = this.data.spec;
    const qty = Math.max(1, spec.qty + d);
    this.setData({ spec: this.buildSpec(spec.dish, spec.picked, qty) });
  },
  confirmSpec() {
    if (this.data.locked) return;
    const spec = this.data.spec;
    const d = spec.dish;
    const sel = {};
    let unit = d.price;
    (d.specs || []).forEach((g) => {
      sel[g.group] = spec.picked[g.group];
      const opt = g.options.find((o) => o.label === spec.picked[g.group]);
      if (opt) unit += (opt.delta || 0);
    });
    for (let i = 0; i < spec.qty; i++) {
      this.addToCart({ dishId: d.id, name: d.name, basePrice: d.price, category: d.category, sel, unitPrice: unit, qty: 1 });
    }
    this.setData({ showSpec: false, spec: null });
  },
  closeSpec() { this.setData({ showSpec: false, spec: null }); },
  callStore() {
    const phone = (this.data.storePhone || '').trim();
    if (!phone) { wx.showToast({ title: '暂未配置门店电话', icon: 'none' }); return; }
    wx.makePhoneCall({ phoneNumber: phone });
  },

  // 改预点：预载顾客已点菜到购物车（店员在真实菜单上加减后整体保存）
  async prefillReservation(reservationId) {
    try {
      const r = await getReservation(reservationId);
      const dishes = (r && r.dishes) || [];
      const cart = dishes.map((d) => {
        const doc = this.data.dishes.find((x) => x.id === d.dish_id);
        return { dishId: d.dish_id, name: d.name, basePrice: doc ? doc.price : 0, category: doc ? doc.category : '', sel: d.sel || {}, unitPrice: doc ? doc.price : 0, qty: d.qty || 1 };
      }).filter((c) => c.dishId);
      this.updateCart(cart);
      // 回显订单备注（点菜时填写），便于店员改预点时看到
      this.setData({ note: (r && r.orderNote) || '' });
    } catch (e) {
      console.warn('[menu] 预载预订菜品失败', e);
    }
  },
  /* ===== 提交订单 ===== */
  async submitOrder() {
    if (!this.data.cart.length) return;
    // 店员追加菜品模式：把购物车菜品写回指定 booking 或 reservation
    if (this.data.appendMode) {
      const dishes = this.data.cart.map((c) => ({
        dish_id: c.dishId, name: c.name,
        image: (this.data.dishes.find((x) => x.id === c.dishId) || {}).image || '',
        qty: c.qty || 1, note: buildSelText(c.sel), sel: c.sel || {},
      }));
      wx.showLoading({ title: '保存中' });
      try {
        if (this.data.appendTarget === 'reservation') {
          // 改预点：店员代改，整体覆盖保存（云端 staffSavePreorder 走员工权限，不受状态限制）
          await staffSavePreorder(this.data.appendReservationId, dishes, this.data.note);
          wx.hideLoading();
          wx.showToast({ title: '已保存预点菜', icon: 'success' });
        } else {
          await callApi('appendBookingDishes', { id: this.data.appendBookingId, dishes, orderNote: this.data.note });
          wx.hideLoading();
          wx.showToast({ title: '已追加 ' + dishes.length + ' 道菜', icon: 'success' });
        }
        setTimeout(() => wx.navigateBack(), 600);
      } catch (e) {
        wx.hideLoading();
        wx.showToast({ title: '保存失败：' + (e.message || ''), icon: 'none' });
      }
      return;
    }
    if (this.data.preorder) {
      if (this.data.locked) {
        wx.showToast({ title: '预点已锁定，请联系店员代加', icon: 'none' });
        return;
      }
      if (!this.data.cart.length) { wx.showToast({ title: '请至少预点一道菜', icon: 'none' }); return; }
      const dishes = this.data.cart.map((c) => ({
        dish_id: c.dishId, name: c.name,
        image: (this.data.dishes.find((x) => x.id === c.dishId) || {}).image || '',
        qty: c.qty || 1, note: buildSelText(c.sel), sel: c.sel || {},
      }));
      // 创建模式（结论 #15）：预点菜与提交预订一步完成
      if (this.createMode) {
        const d = this.draft || {};
        if (!d.date || !/^1[3-9]\d{9}$/.test(d.contactPhone || '')) {
          wx.showToast({ title: '预订信息缺失，请重试', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 800);
          return;
        }
        wx.showLoading({ title: '提交中' });
        try {
          await submitReservation({
            date: d.date, expectedArrival: d.expectedArrival,
            partySize: d.partySize, contactPhone: d.contactPhone, note: d.note || '', dishes,
            roomNo: d.roomNo || '', orderNote: this.data.note,
          });
          wx.hideLoading();
          wx.showToast({ title: '已提交订位，等待确认', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 700);
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '提交失败：' + (e.message || ''), icon: 'none' });
        }
        return;
      }
      // 已有预订：保存预点菜
      wx.showLoading({ title: '保存中' });
      try {
        await savePreorder(this.data.reservationId, dishes, this.data.note);
        wx.hideLoading();
        wx.showToast({ title: '已保存预点菜', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      } catch (e) {
        wx.hideLoading();
        wx.showToast({ title: '保存失败：' + (e.message || ''), icon: 'none' });
      }
      return;
    }
    const items = this.data.cart.map((c) => ({
      name: c.name, unitPrice: c.unitPrice, qty: c.qty || 1, sel: c.sel, category: c.category,
      selText: buildSelText(c.sel),
      subtotalText: fmt(c.unitPrice * (c.qty || 1)),
    }));
    const total = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    const note = (this.data.note || '').trim();
    wx.showLoading({ title: '提交中' });
    try {
      await submitOrder({
        roomNo: this.data.roomNo, roomName: this.data.roomName,
        people: this.data.people, items, total, note,
      });
      this.updateCart([]);
      this.setData({
        showConfirm: false, showCart: false, note: '',
        showBill: true,
        bill: { items, totalText: fmt(total), roomName: this.data.roomName, roomNo: this.data.roomNo, people: this.data.people, note },
      });
    } catch (e) {
      wx.showToast({ title: '提交失败：' + (e.message || ''), icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
  closeBill() { this.setData({ showBill: false }); },
  goOrders() {
    this.setData({ showBill: false });
    // 下单成功后直接回到包厢页，并定位到「订单 → 现场下单菜品」
    wx.redirectTo({ url: '/pages/room/room?tab=order&sub=live' });
  },
  setPeople() {
    const opts = [];
    for (let i = 1; i <= 12; i++) opts.push(i + ' 人');
    wx.showActionSheet({
      itemList: opts,
      success: (res) => {
        const p = res.tapIndex + 1;
        app.globalData.people = p;
        this.setData({ people: p });
      },
    });
  },
});
