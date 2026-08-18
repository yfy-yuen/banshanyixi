const { ROOMS } = require('../../utils/config');
const { getOrdersByRoomName, callApi } = require('../../utils/api');
const app = getApp();

function pad(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// 棋牌分午间/晚间；用餐分午/晚
function bookingLabel(b) {
  if (b.type === 'game') return b.slot === 'lunch' ? '午间棋牌' : '晚间棋牌';
  return b.slot === 'lunch' ? '午餐订餐' : '晚餐订餐';
}
function decorateOrder(o) {
  const items = (o.items || []).map((i) => ({
    ...i,
    selText: i.sel && Object.keys(i.sel).length ? '（' + Object.values(i.sel).join('/') + '）' : '',
  }));
  return {
    ...o, items,
    totalText: '¥' + Number(o.total || 0).toFixed(2),
    statusText: o.status === 'paid' ? '已结账' : '未结账',
    createdText: (o.created_at || '').replace('T', ' ').slice(0, 16),
  };
}

Page({
  data: {
    roomNo: '', roomName: '',
    tab: 'env', // env | order | menu
    orderSub: 'book', // book 订餐菜品 | live 现场下单菜品
    envPhotos: [], restaurantPhotos: [],
    cover: '', introHtml: '',
    dateLabel: '', typeLabel: '', dishes: [],
    liveOrders: [],
    loading: true,
  },
  onLoad(options) {
    const no = options.room || app.globalData.roomNo || '1';
    const name = ROOMS[no] || ('厢' + no);
    const tab = options.tab === 'order' ? 'order' : 'env';
    const orderSub = options.sub === 'live' ? 'live' : 'book';
    this.setData({ roomNo: no, roomName: name, tab, orderSub });
    wx.setStorageSync('roomNo', no);
    wx.setStorageSync('roomName', name);
    this.loadData(no);
  },
  async loadData(no) {
    this.setData({ loading: true });
    try {
      // 三个云调用并行，冷启动叠加时长从「串行之和」降为「单次最慢」，明显缩短白屏
      const [rooms, bookings, o] = await Promise.all([
        callApi('rooms'),
        callApi('bookings'),
        getOrdersByRoomName(this.data.roomName).catch(() => []),
      ]);
      const room = (rooms || []).find((x) => x.id === no || x.room_no === no) || {};
      const list = (bookings || []).filter((x) => x.room_id === no);
      const today = todayStr();
      const sorted = list.slice().sort((a, c) => (a.date < c.date ? -1 : 1));
      const pick = list.find((x) => x.date === today) || sorted[0];
      let dateLabel = '', typeLabel = '', dishes = [];
      if (pick) {
        dateLabel = pick.date;
        typeLabel = bookingLabel(pick);
        dishes = pick.dishes || [];
      }
      const cover = room.cover || (room.env_photos && room.env_photos[0]) || '';
      let introHtml = room.intro || '';
      if (introHtml) introHtml = await this.introToDisplay(introHtml); // 富文本插图 cloud:// → 临时链
      const liveOrders = (o || []).map(decorateOrder);
      this.setData({
        envPhotos: room.env_photos || [],
        restaurantPhotos: room.restaurant_photos || [],
        cover, introHtml,
        dateLabel, typeLabel, dishes, liveOrders,
        loading: false,
      });
    } catch (e) {
      console.warn('[room] 加载失败', e);
      this.setData({ loading: false });
    }
  },
  switchTab(e) {
    const t = e.currentTarget.dataset.tab;
    if (t === 'menu') {
      this.goMenu();
      return;
    }
    this.setData({ tab: t });
  },
  // 醒目「去点单」入口：从包厢详情直接进点菜页（带 roomNo），打通「看厢 → 点单」闭环
  goMenu() {
    wx.navigateTo({ url: '/pages/menu/menu?roomNo=' + this.data.roomNo });
  },
  switchOrderSub(e) {
    this.setData({ orderSub: e.currentTarget.dataset.sub });
  },
  // 富文本插图以 cloud:// 存储（永久），显示时批量换成临时 https 链，rich-text 才能渲染
  async introToDisplay(html) {
    const re = /<img[^>]+src=["']([^"']*cloud:\/\/[^"']*)["']/g;
    const clouds = [];
    let m;
    while ((m = re.exec(html)) !== null) clouds.push(m[1]);
    if (!clouds.length) return html;
    const uniq = [...new Set(clouds)];
    const r = await new Promise((res) => wx.cloud.getTempFileURL({ fileList: uniq, success: res, fail: res }));
    (r.fileList || []).forEach((f) => { if (f.tempFileURL) html = html.split(f.fileID).join(f.tempFileURL); });
    return html;
  },
});
