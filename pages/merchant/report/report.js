const { detectTablet } = require('../../../utils/tablet');
// pages/merchant/report/report.js
Page({
  data: {
    isTablet: false,
    total: 0,
    byCategory: []
  },

  
  onLoad() {
    this.setData({ isTablet: detectTablet() });
  },
onShow() {
    this.load()
  },

  load() {
    wx.cloud.callFunction({ name: 'getReport' }).then(res => {
      const r = res.result || {}
      this.setData({ total: r.total || 0, byCategory: r.byCategory || [] })
    })
  }
})
