const { ROOMS } = require('../../utils/config');
const { callApi, markArrived, roomAccess, joinByInvite } = require('../../utils/api');
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
    noteText: (o.note || '').trim(),
  };
}

Page({
  data: {
    roomNo: '', roomName: '',
    tab: 'env', // env | order | menu
    orderSub: 'book', // book 订餐菜品 | live 现场下单菜品
    envPhotos: [], restaurantPhotos: [],
    cover: '', introHtml: '',
    unlocked: false, // 包厢门禁：是否为本桌关联人（主订人/同桌/店家）
    lunchDishes: [], dinnerDishes: [], // 分餐段聚合的预点菜
    liveOrders: [],
    codeInput: '', // 同桌邀请码输入
    joining: false,
    joinErr: '',
    loading: true,
  },
  async onLoad(options) {
    const no = options.room || app.globalData.roomNo || '1';
    const name = ROOMS[no] || ('厢' + no);
    const tab = options.tab === 'order' ? 'order' : 'env';
    const orderSub = options.sub === 'live' ? 'live' : 'book';
    this.setData({ roomNo: no, roomName: name, tab, orderSub, loading: true });
    wx.setStorageSync('roomNo', no);
    wx.setStorageSync('roomName', name);
    // 分享链接 / 小程序码进入：自动凭码加入本桌（绑定到该 reservation，加不进别的订单）
    const code = (options.code || (options.scene ? decodeURIComponent(options.scene) : '')) || '';
    if (code) {
      try {
        const jr = await joinByInvite(code);
        if (jr && jr.id) wx.showToast({ title: '已加入本桌', icon: 'success' });
        else if (jr && jr.error) wx.showToast({ title: jr.error, icon: 'none' });
      } catch (e) { console.warn('[room join]', e.message); }
    }
    // 结论 #1：进入「自己预订的」包厢内页即静默标记到店（须该厢+已到预计时间，后端校验防误标）
    markArrived(no).catch(() => {});
    await this.loadData(no);
  },
  async loadData(no) {
    this.setData({ loading: true });
    try {
      // 并行：公开房间信息 + 按身份裁剪的包厢门禁数据（私密菜品只在该用户授权时返回）
      const [rooms, acc] = await Promise.all([
        callApi('rooms'),
        roomAccess(no, this.data.roomName, todayStr()).catch(() => ({ unlocked: false })),
      ]);
      const room = (rooms || []).find((x) => x.id === no || x.room_no === no) || {};
      const cover = room.cover || (room.env_photos && room.env_photos[0]) || '';
      let introHtml = room.intro || '';
      if (introHtml) introHtml = await this.introToDisplay(introHtml); // 富文本插图 cloud:// → 临时链

      const unlocked = !!(acc && acc.unlocked);
      const lunchDishes = [], dinnerDishes = [];
      let liveOrders = [];
      if (unlocked && acc.bookDishes) {
        acc.bookDishes.forEach((b) => {
          const arr = (b.slot === 'lunch') ? lunchDishes : dinnerDishes;
          (b.dishes || []).forEach((d) => arr.push(d));
        });
        liveOrders = (acc.liveOrders || []).map(decorateOrder);
      }
      this.setData({
        envPhotos: room.env_photos || [],
        restaurantPhotos: room.restaurant_photos || [],
        cover, introHtml,
        unlocked, lunchDishes, dinnerDishes, liveOrders,
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
    if (!this.data.unlocked) {
      wx.showToast({ title: '请先加入本桌再点单', icon: 'none' });
      this.setData({ tab: 'order' });
      return;
    }
    wx.navigateTo({ url: '/pages/menu/menu?roomNo=' + this.data.roomNo });
  },
  onCodeInput(e) { this.setData({ codeInput: (e.detail.value || '').toUpperCase(), joinErr: '' }); },
  async joinWithCode() {
    const code = (this.data.codeInput || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { this.setData({ joinErr: '请输入 6 位邀请码' }); return; }
    this.setData({ joining: true, joinErr: '' });
    try {
      const jr = await joinByInvite(code);
      if (jr && jr.id) {
        wx.showToast({ title: '已加入本桌', icon: 'success' });
        this.setData({ codeInput: '' });
        await this.loadData(this.data.roomNo); // 重新拉取（此时已解锁）
      } else if (jr && jr.error) {
        this.setData({ joinErr: jr.error });
      } else {
        this.setData({ joinErr: '加入失败，请重试' });
      }
    } catch (e) {
      this.setData({ joinErr: '网络异常，请重试' });
    } finally {
      this.setData({ joining: false });
    }
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
