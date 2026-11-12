// 隐私政策页（上架合规三件套之一，2026-11-12 新增）
// 纯静态展示页，不读写任何云端数据、不触碰预订/下单逻辑。
const { STORE_NAME } = require('../../utils/config');
const { detectTablet } = require('../../utils/tablet');

Page({
  data: {
    isTablet: false,
    storeName: STORE_NAME,
    updated: '2026-11-12',
  },
  onLoad() {
    this.setData({ isTablet: detectTablet() });
  },
  // 返回；若被分享/扫码直接打开（栈内无上一页），退回关于页
  goBack() {
    wx.navigateBack({
      fail: () => wx.redirectTo({ url: '/pages/about/about' }),
    });
  },
});
