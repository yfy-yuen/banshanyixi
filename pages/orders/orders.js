const { getOrdersByRoom } = require('../../utils/api');
const { fmt } = require('../../utils/config');
const app = getApp();

function decorate(o) {
  const items = (o.items || []).map((i) => ({
    ...i,
    selText: i.sel && Object.keys(i.sel).length ? '（' + Object.values(i.sel).join('/') + '）' : '',
  }));
  return {
    ...o,
    items,
    totalText: fmt(o.total),
    createdText: (o.created_at || '').replace('T', ' ').slice(0, 16),
  };
}

Page({
  data: { roomNo: '', roomName: '', list: [], needRoom: false },
  onShow() {
    const roomNo = app.globalData.roomNo;
    const roomName = app.globalData.roomName;
    if (!roomNo) {
      this.setData({ needRoom: true, list: [] });
      return;
    }
    this.setData({ needRoom: false, roomNo, roomName });
    this.load();
  },
  async load() {
    wx.showLoading({ title: '加载中' });
    try {
      const raw = await getOrdersByRoom(this.data.roomNo);
      this.setData({ list: raw.filter((o) => !o.closed).map(decorate) });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      wx.stopPullDownRefresh();
    }
  },
  onPullDownRefresh() { this.load(); },
  goRooms() { wx.switchTab({ url: '/pages/rooms/rooms' }); },
  goMenu() { wx.navigateTo({ url: '/pages/menu/menu?roomNo=' + this.data.roomNo }); },
});
