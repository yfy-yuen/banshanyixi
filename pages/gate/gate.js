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
    rawSrc: '', // 原始 cloud:// 源，点击推门时重新解析拿新鲜临时链，规避时效导致的黑屏
    videoPoster: '',
    videoVisible: true,
    fallbackMode: false, // 视频不可用 → 退回 CSS 静态兜底，防黑屏卡死
  },
  onLoad() {
    // 距上次开过门不足刷新间隔 → 直达包厢列表（不播视频）；否则展示开门页
    const last = wx.getStorageSync('gateShownAt') || 0;
    const now = Date.now();
    if (last && now - last < GATE_REFRESH_MS) {
      wx.switchTab({ url: '/pages/rooms/rooms' });
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
        rawSrc: raw,
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
    wx.setStorageSync('enterFlash', '1'); // 通知包厢页播放进门强光转场
    if (this.data.fallbackMode || !this.data.rawSrc) {
      wx.switchTab({ url: '/pages/rooms/rooms' });
      return;
    }
    this.setData({ open: true }); // 隐藏覆盖文字层
    // 用原始 cloud:// 重新解析，拿新鲜临时链再播，规避临时链时效导致的黑屏
    const play = () => {
      const v = wx.createVideoContext('gateVideo', this);
      if (v && typeof v.play === 'function') v.play();
    };
    this.resolveCloudMedia(this.data.rawSrc, '', (freshUrl) => {
      if (freshUrl) this.setData({ videoSrc: freshUrl }, play);
      else play();
    });
  },
  onVideoEnd() {
    wx.switchTab({ url: '/pages/rooms/rooms' });
  },
  onVideoError() {
    // 视频加载/播放失败 → 退回静态兜底，避免黑屏卡死
    if (!this.data.fallbackMode) {
      this.setData({ fallbackMode: true, videoVisible: false });
    }
  },
  // 隐藏老板注册入口：视频模式下原生组件限制，由"长按"改为"点击"触发（功能不变）。
  bindBossEntry() {
    const app = getApp();
    if (wx.getStorageSync('bossUnlocked') === '1') {
      wx.switchTab({ url: '/pages/merchant/merchant' });
      return;
    }
    wx.showModal({
      title: '老板注册',
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
