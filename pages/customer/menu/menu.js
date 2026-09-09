const { detectTablet } = require('../../../utils/tablet');
// pages/customer/menu/menu.js
const app = getApp()

Page({
  data: {
    isTablet: false,
    tableNo: '',
    categories: [],
    cart: {},
    cartCount: 0,
    cartTotal: 0,
    submitting: false,
    previewSrc: ''
  },

  onLoad(options) {
    this.setData({ isTablet: detectTablet() });
    if (options.tableNo) {
      this.setData({ tableNo: options.tableNo })
    }
    this.loadMenu()
  },

  loadMenu() {
    wx.cloud.callFunction({ name: 'getMenu' }).then(res => {
      const list = (res.result && res.result.data) || []
      const map = {}
      list.forEach(d => { (map[d.category] = map[d.category] || []).push(d) })
      const categories = Object.keys(map).map(c => ({ name: c, dishes: map[c] }))
      this.setData({ categories })
    })
  },

  onTableInput(e) {
    this.setData({ tableNo: e.detail.value })
  },

  add(e) {
    const id = e.currentTarget.dataset.id
    const cart = Object.assign({}, this.data.cart)
    cart[id] = (cart[id] || 0) + 1
    this.recalc(cart)
  },

  minus(e) {
    const id = e.currentTarget.dataset.id
    const cart = Object.assign({}, this.data.cart)
    if (cart[id]) {
      cart[id] -= 1
      if (cart[id] <= 0) delete cart[id]
    }
    this.recalc(cart)
  },

  recalc(cart) {
    let count = 0
    let total = 0
    const all = this.data.categories.reduce((a, c) => a.concat(c.dishes), [])
    Object.keys(cart).forEach(id => {
      const d = all.find(x => x._id === id)
      if (d) {
        count += cart[id]
        total += cart[id] * d.price
      }
    })
    this.setData({ cart, cartCount: count, cartTotal: total })
  },

  submit() {
    const { tableNo, cart, cartCount } = this.data
    if (!tableNo) {
      wx.showToast({ title: '请填写桌号', icon: 'none' })
      return
    }
    if (cartCount === 0) {
      wx.showToast({ title: '请先点菜', icon: 'none' })
      return
    }
    const all = this.data.categories.reduce((a, c) => a.concat(c.dishes), [])
    const items = Object.keys(cart).map(id => {
      const d = all.find(x => x._id === id)
      return { dishId: id, name: d.name, price: d.price, qty: cart[id], category: d.category }
    })
    this.setData({ submitting: true })
    wx.cloud.callFunction({ name: 'createOrder', data: { tableNo, items } })
      .then(res => {
        const orderId = res.result && res.result.orderId
        wx.navigateTo({ url: `/pages/customer/bill/bill?orderId=${orderId}` })
      })
      .catch(() => {
        wx.showToast({ title: '下单失败', icon: 'none' })
      })
      .finally(() => {
        this.setData({ submitting: false })
      })
  },

  // 点击菜品图放大预览：页面内遮罩 <image> 直接渲染（原生支持 cloud://，比 wx.previewImage 稳）
  previewImage(e) {
    const file = e.currentTarget.dataset.img;
    console.log('[previewImage] open overlay file=', file);
    if (!file) {
      wx.showToast({ title: '该菜品暂无图片', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已放大', icon: 'none', duration: 500 });
    this.setData({ previewSrc: file });
  },
  closePreview() {
    this.setData({ previewSrc: '' });
  },
  noop() {}
})
