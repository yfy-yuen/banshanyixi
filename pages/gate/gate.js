// 开门动画刷新间隔：用户明确要求 1 分钟（60 * 1000）。
// ⚠️ 受保护：除非用户在下一条指令中明确点名要改 GATE_REFRESH_MS / 开门时间，否则任何指令（含"自规划内容"）都不得修改本值。
const GATE_REFRESH_MS = 1 * 60 * 1000;

const { bindBoss } = require('../../utils/api');
const { GATE_VIDEO_SRC, GATE_VIDEO_POSTER } = require('../../utils/config');

Page({
  data: {
    show: false,
    open: false,
    videoSrc: '',
    videoPoster: '',
    videoVisible: false, // ⚠️ 初始不渲染 video：避免空 src 触发 binderror 误判为视频失败。解析出有效 src 后才置 true。
    fallbackMode: false, // 视频不可用 → 退回 CSS 静态兜底，防黑屏卡死
    tablet: false, // 平板（大屏）锁定封面字体为固定 px，避免 rpx 等比放大
    gateFont: null, // 平板下各封面文字的固定 px（按当前屏宽换算，视觉与现在一致）
    gateBtn: null, // 平板下「推门入席」按钮容器（宽/高/左/圆角）固定 px，避免 rpx 放大（2026-08-27）
  },
  onLoad() {
    // 平板（大屏）锁定封面字体：按当前屏宽把 rpx 换算为固定 px，视觉与现在一致，之后不随手机端 rpx 变化（2026-08-27 用户要求）
    let winW = 375;
    try {
      if (wx.getWindowInfo) winW = wx.getWindowInfo().windowWidth || winW;
      else winW = wx.getSystemInfoSync().windowWidth || winW;
    } catch (e) {}
    const tablet = winW >= 600;
    const scale = winW / 750; // 1rpx 在当前屏宽的等效 px = 当前渲染比例
    const gateFont = tablet ? {
      plaque: (74 * scale).toFixed(1),
      poem: (46 * scale).toFixed(1),
      btn: (46 * scale).toFixed(1),
      sub: (30 * scale).toFixed(1),
      boss: (29 * scale).toFixed(1),
      fb: (53 * scale).toFixed(1),
    } : null;
    // 平板「推门入席」按钮容器钉死为原尺寸（缩放后固定 px），手机端改 wxss 不影响它
    const gateBtn = tablet ? {
      w: (200 * scale).toFixed(1),
      h: (62 * scale).toFixed(1),
      left: (275 * scale).toFixed(1),
      radius: (31 * scale).toFixed(1),
    } : null;
    this.setData({ tablet, gateFont, gateBtn });

    // 距上次开过门不足刷新间隔 → 直达包厢列表（不播视频）；否则展示开门页
    const last = wx.getStorageSync('gateShownAt') || 0;
    const now = Date.now();
    if (last && now - last < GATE_REFRESH_MS) {
      wx.switchTab({ url: '/pages/mine/mine' });
      return;
    }
    const raw = GATE_VIDEO_SRC || '';
    if (!raw) {
      // 无视频源 → 直接 CSS 兜底，避免黑屏卡死
      this.setData({ show: true, fallbackMode: true, videoVisible: false, videoSrc: '' });
      return;
    }
    // ⚠️ 关键修复：微信 <video> 多数基础库版本不会自动解析 cloud:// 文件ID，
    // 直接喂 cloud:// 会加载失败 → 退回兜底（无图）。src 和 poster 都必须先转成 https 临时链。
    this.resolveCloudMedia(raw, GATE_VIDEO_POSTER || '', (videoUrl, posterUrl) => {
      if (!videoUrl) {
        this.setData({ show: true, fallbackMode: true, videoVisible: false, videoSrc: '' });
        return;
      }
      this.setData({
        show: true,
        videoSrc: videoUrl,
        videoPoster: posterUrl || '',
        fallbackMode: false,
        videoVisible: true,
      });
    });
  },
  // 把 cloud:// 转成 https 临时链；非 cloud:// 原样返回。
  resolveCloudMedia(videoRaw, posterRaw, cb) {
    const conv = (raw) => new Promise((resolve) => {
      if (!raw || raw.indexOf('cloud://') !== 0) return resolve(raw || '');
      wx.cloud.getTempFileURL({
        fileList: [raw],
        success: (res) => {
          const it = (res.fileList && res.fileList[0]) || {};
          resolve(it.tempFileURL || '');
        },
        fail: () => resolve(''),
      });
    });
    Promise.all([conv(videoRaw), conv(posterRaw)]).then(([v, p]) => cb(v, p));
  },
  // 推门入席：播放开门视频，播完跳包厢页；无视频则直接进
  enter() {
    if (this.data.open) return;
    wx.setStorageSync('gateShownAt', Date.now());
    if (this.data.fallbackMode) {
      wx.switchTab({ url: '/pages/mine/mine' });
      return;
    }
    if (!this.data.videoSrc) {
      // 视频源尚未就绪（极少见：onLoad 解析未完成即点击）→ 直接进，避免卡死
      wx.switchTab({ url: '/pages/mine/mine' });
      return;
    }
    this.setData({ open: true }); // 隐藏覆盖文字层
    // ⚠️ 关键：直接播放 onLoad 已就绪的视频，绝不在点击时改动 videoSrc。
    // 之前在 enter 里用 rawSrc 重新解析并 setData 改 src，导致 <video> 重新加载、
    // play() 时机早于新源就绪 → 视频卡在首帧"动不了"。这是本次卡死的真因。
    const tryPlay = () => {
      const v = wx.createVideoContext('gateVideo', this);
      if (v && typeof v.play === 'function') v.play();
    };
    tryPlay();
    // 双保险：个别机型首次 play() 不生效，延迟再触发一次
    clearTimeout(this._playT);
    this._playT = setTimeout(tryPlay, 120);
  },
  onVideoEnd() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },
  onVideoError() {
    // 视频加载/播放失败 → 退回静态兜底，避免黑屏卡死
    if (!this.data.fallbackMode) {
      this.setData({ fallbackMode: true, videoVisible: false });
    }
  },
  // 分流：订一席（跳订位提交页，普通页 navigateTo）
  goReserve() {
    wx.navigateTo({ url: '/pages/reserve/reserve' });
  },
  // 分流：入席去（跳「我的今日」页，按身份显示今日包厢与预点菜）
  goArrive() {
    wx.navigateTo({ url: '/pages/today/today' });
  },
  // 隐藏老板注册入口：视频模式下原生组件限制，由"长按"改为"点击"触发（功能不变）。
  bindBossEntry() {
    const app = getApp();
    if (wx.getStorageSync('bossUnlocked') === '1') {
      wx.switchTab({ url: '/pages/merchant/merchant' });
      return;
    }
    wx.showModal({
      title: '半山一席',
      editable: true,
      placeholderText: '请输入解锁码',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '验证中' });
        try {
          const r = await bindBoss((res.content || '').trim());
          wx.hideLoading();
          if (r && r.role === 'manager') {
            app.globalData.uid = r.openid || app.globalData.uid;
            app.unlockBoss(); // 本机标记 + 通知 tabBar 重新渲染
            wx.showToast({ title: '已注册为老板', icon: 'success' });
            setTimeout(() => wx.switchTab({ url: '/pages/merchant/merchant' }), 600);
          } else {
            wx.showToast({ title: '解锁码错误', icon: 'none' });
          }
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: e.message || '失败', icon: 'none' });
        }
      },
    });
  },
});
