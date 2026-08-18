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
    videoDuration: 11, // 视频真实时长（秒），由 loadedmetadata 回填；默认 11 兜底
    videoVisible: false, // ⚠️ 初始不渲染 video：避免空 src 触发 binderror 误判为视频失败。解析出有效 src 后才置 true。
    fallbackMode: false, // 视频不可用 → 退回 CSS 静态兜底，防黑屏卡死
    _jumped: false, // 防 onVideoEnd 与超时兜底重复跳转
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
    wx.setStorageSync('enterFlash', '1'); // 通知包厢页播放进门转场
    if (this.data.fallbackMode) {
      wx.switchTab({ url: '/pages/rooms/rooms' });
      return;
    }
    if (!this.data.videoSrc) {
      // 视频源尚未就绪（极少见：onLoad 解析未完成即点击）→ 直接进，避免卡死
      wx.switchTab({ url: '/pages/rooms/rooms' });
      return;
    }
    this.setData({ open: true }); // 隐藏覆盖文字层
    // ⚠️ 关键：直接播放 onLoad 已就绪的视频，绝不在点击时改动 videoSrc。
    // 之前在 enter 里用 rawSrc 重新解析并 setData 改 src，导致 <video> 重新加载、
    // play() 时机早于新源就绪 → 视频卡在首帧"动不了"。这是之前卡死的真因。
    this.playVideo();
    // 兜底：bindended 万一不触发（机型/基础库差异），按真实时长(+3s 缓冲)强制跳转，绝不卡死
    this.armSafeJump();
  },
  playVideo() {
    const v = wx.createVideoContext('gateVideo', this);
    if (v && typeof v.play === 'function') {
      v.play();
      // 个别机型首次 play() 不生效，延迟再触发一次
      clearTimeout(this._playT);
      this._playT = setTimeout(() => { try { v.play(); } catch (e) {} }, 200);
    }
  },
  // 视频元数据就绪：回填真实时长（用于超时兜底），若已进入则确保开播
  onVideoMeta(e) {
    const d = e.detail && e.detail.duration;
    if (d && d > 0) this.setData({ videoDuration: Math.ceil(d) });
    if (this.data.open && !this.data._jumped) this.playVideo();
  },
  armSafeJump() {
    clearTimeout(this._safeT);
    const dur = this.data.videoDuration || 11; // 秒
    this._safeT = setTimeout(() => {
      if (this.data._jumped) return;
      this.setData({ _jumped: true });
      wx.switchTab({ url: '/pages/rooms/rooms' });
    }, (dur + 3) * 1000);
  },
  onVideoEnd() {
    if (this.data._jumped) return;
    this.setData({ _jumped: true });
    clearTimeout(this._safeT);
    wx.switchTab({ url: '/pages/rooms/rooms' });
  },
  onVideoError() {
    // 视频加载/播放失败 → 退回静态木门兜底（带「推门而入」按钮），绝不自动跳走。
    // ⚠️ 之前曾改为直接 switchTab 进房间，结果真机任何非致命 error（临时链首请求慢、解码初始化）
    // 都会 binderror 触发 → 门直接消失、开门动画"没了"。改回 fallback：至少看得到门、且有入口、不会卡死。
    clearTimeout(this._safeT);
    this.setData({ fallbackMode: true, videoVisible: false });
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
