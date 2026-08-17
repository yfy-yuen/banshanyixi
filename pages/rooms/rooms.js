const { ROOMS } = require('../../utils/config');

const app = getApp();

Page({
  data: {
    rooms: [],
    flash: false,    // 进门帷幔：瞬间铺满暖光，盖住首帧内容，避免「先露内容再闪」
    flashFade: false, // 稍候平滑渐隐，露出页面
  },
  onLoad() {
    // 兜底：即使 ROOMS 因某种原因未取到，也给出默认 4 个包厢，避免空白
    const src = (ROOMS && typeof ROOMS === 'object') ? ROOMS : { '1': '谷山玥', '2': '满仓', '3': '枕山', '5': '云起' };
    this.setData({
      rooms: Object.entries(src).map(([no, name]) => ({ no, name })),
    });
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selectedKey: 'rooms' });
    }
    // 进门转场：开门页「推门入席」进入时触发（enterFlash 置位）。
    // 先瞬间铺满暖光帷幔盖住首帧，稍候平滑渐隐，内容随之优雅浮现。
    if (wx.getStorageSync('enterFlash')) {
      wx.removeStorageSync('enterFlash');
      this.setData({ flash: true });
      clearTimeout(this._flashT);
      this._flashT = setTimeout(() => this.setData({ flashFade: true }), 80);
      clearTimeout(this._cleanT);
      this._cleanT = setTimeout(() => this.setData({ flash: false, flashFade: false }), 1600);
    }
  },
  chooseRoom(e) {
    const { no, name } = e.currentTarget.dataset;
    if (app && app.globalData) {
      app.globalData.roomNo = no;
      app.globalData.roomName = name;
    }
    wx.setStorageSync('roomNo', no);
    wx.setStorageSync('roomName', name);
    wx.navigateTo({ url: `/pages/room/room?room=${no}` });
  },
});
