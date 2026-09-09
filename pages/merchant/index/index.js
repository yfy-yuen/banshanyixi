const { detectTablet } = require('../../../utils/tablet');
// pages/merchant/index/index.js
Page({
  data: {
    isTablet: false,
    orders: []
  },

  
  onLoad() {
    this.setData({ isTablet: detectTablet() });
  },
onShow() {
    this.load()
  },

  load() {
    wx.cloud.callFunction({ name: 'getOrders' }).then(res => {
      this.setData({ orders: (res.result && res.result.data) || [] })
    })
  },

  settle(e) {
    const id = e.currentTarget.dataset.id
    wx.cloud.callFunction({ name: 'settleOrder', data: { orderId: id } }).then(() => {
      wx.showToast({ title: '已结账' })
      this.load()
    })
  },

  goDishes() {
    wx.navigateTo({ url: '/pages/merchant/dishes/dishes' })
  },

  goReport() {
    wx.navigateTo({ url: '/pages/merchant/report/report' })
  }
})
