const { detectTablet } = require('../../../utils/tablet');
// pages/merchant/dishes/dishes.js
Page({
  data: {
    isTablet: false,
    dishes: [],
    cats: ['热菜', '凉菜', '饮品', '主食', '其他'],
    form: { name: '', category: '热菜', price: '', image: '' }
  },

  
  onLoad() {
    this.setData({ isTablet: detectTablet() });
  },
onShow() {
    this.load()
  },

  load() {
    wx.cloud.callFunction({ name: 'getMenu', data: { all: true } }).then(res => {
      this.setData({ dishes: (res.result && res.result.data) || [] })
    })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  onCat(e) {
    this.setData({ 'form.category': this.data.cats[e.detail.value] })
  },

  chooseImage() {
    const that = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success(res) {
        const filePath = res.tempFiles[0].tempFilePath
        wx.showLoading({ title: '上传中' })
        const m = filePath.match(/\.(\w+)$/)
        const ext = m ? m[1] : 'png'
        const cloudPath = 'dish-images/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext
        wx.cloud.uploadFile({ cloudPath, filePath })
          .then(up => {
            that.setData({ 'form.image': up.fileID })
            wx.hideLoading()
            wx.showToast({ title: '已选图片' })
          })
          .catch(() => {
            wx.hideLoading()
            wx.showToast({ title: '上传失败', icon: 'none' })
          })
      }
    })
  },

  removeImage() {
    this.setData({ 'form.image': '' })
  },

  add() {
    const { name, category, price, image } = this.data.form
    if (!name || !price) {
      wx.showToast({ title: '请填名称和价格', icon: 'none' })
      return
    }
    wx.cloud.callFunction({ name: 'addDish', data: { name, category, price: Number(price), image } })
      .then(() => {
        wx.showToast({ title: '已添加' })
        this.setData({ form: { name: '', category: '热菜', price: '', image: '' } })
        this.load()
      })
  }
})
