// 门店信息页（banshan-product-vision 第 17 条）：关于我们 / 营业时间 / 地址导航 / 一键拨打。
// 纯前端页，不依赖 dataApi 部署与订阅推送。门店地址/电话/经纬度统一从 utils/config 的 STORE_* 读取。

const { STORE_ADDR, STORE_PHONE, STORE_LAT, STORE_LNG, STORE_NAME } = require('../../utils/config');

Page({
  data: {
    // 品牌故事
    story: '半山·一席，藏于山坡 22 号的私人菜馆。不接待散客，只待有约之人。\n\n一席之地，半山之间。循时令而食，依客意而烹——这是我们对「吃」这件事的全部讲究。',
    hours: '午市 11:00 – 14:00　晚市 17:00 – 22:00',
    address: STORE_ADDR,
    phone: STORE_PHONE,
    storeName: STORE_NAME,
    // 经纬度（GCJ-02）。填 0 表示未设置，点击导航会提示先补全。
    lat: STORE_LAT,
    lng: STORE_LNG,
  },

  // 地图导航
  goNav() {
    const { lat, lng, address, storeName } = this.data;
    if (!lat || !lng) {
      wx.showToast({ title: '门店位置待补充', icon: 'none' });
      return;
    }
    wx.openLocation({ latitude: lat, longitude: lng, name: storeName, address });
  },

  // 一键拨打（多个号码用 / 分隔时，取第一个）
  call() {
    const first = (this.data.phone || '').split('/')[0].trim();
    const phone = first.replace(/[^\d]/g, '');
    if (!phone) {
      wx.showToast({ title: '电话待补充', icon: 'none' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone });
  },
});
