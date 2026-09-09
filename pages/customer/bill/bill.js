const { detectTablet } = require('../../../utils/tablet');
// pages/customer/bill/bill.js
Page({
  data: {
    isTablet: false,
    order: null
  },

  onLoad(options) {
    this.setData({ isTablet: detectTablet() });
    const orderId = options.orderId
    wx.cloud.callFunction({ name: 'getOrders' }).then(res => {
      const list = (res.result && res.result.data) || []
      const order = list.find(o => o._id === orderId)
      this.setData({ order })
    })
  }
})
