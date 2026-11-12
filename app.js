require('./utils/runtime.js'); // 提供 async/await 运行时（关闭增强编译后必需）
const { preflight } = require('./utils/cloudbase');
const { callApi, ownerBoot } = require('./utils/api');
const { ENV } = require('./utils/config'); // ENV 用于初始化微信云能力

// 平板判定：逻辑宽 >= 600 视为平板（手机竖屏 375、横屏 667 仍算手机；iPad/安卓平板 >=768 判平板）。
// 用 getSystemInfoSync，兼容性最好（所有基础库都有）；getWindowInfo 某些版本行为异常，故统一用 sync。
function detectTablet() {
  try {
    const info = wx.getSystemInfoSync();
    const w = info.windowWidth || info.screenWidth || 375;
    return w >= 600;
  } catch (e) { return false; }
}

App({
  globalData: {
    roomNo: '',
    roomName: '',
    people: 1,
    uid: '',          // 微信 OPENID（云函数上下文自动附带，稳定身份，作为 staff 锚定）
    role: '',         // ''=加载中 | 'guest' | 'clerk' | 'manager'
    isTablet: false,  // 运行时平板判定（windowWidth >= 600），驱动 .is-tablet 类放大内页
  },
  onLaunch() {
    // 初始化微信原生云能力（顾客/下单/查询统一经云函数调用，云函数再访问 cloud1 文档库）
    try { wx.cloud.init({ env: ENV, traceUser: false }); } catch (e) { console.warn('[app] wx.cloud.init 已初始化或失败', e); }
    // 平板判定：逻辑宽 >= 600 → 驱动 .is-tablet 放大内页；手机不触发
    this.globalData.isTablet = detectTablet();
    // 恢复上次选择的包厢
    const roomNo = wx.getStorageSync('roomNo');
    const roomName = wx.getStorageSync('roomName');
    if (roomNo) {
      this.globalData.roomNo = roomNo;
      this.globalData.roomName = roomName;
    }
    // 原生 wx.cloud 已于上面 init；小程序端不再初始化 CloudBase SDK（2026-11-12 主包瘦身）
    // 微信身份 + 角色（顾客 / 店员 / 店长）——基于 OPENID 静默判定，无需登录框
    this.initRole();
    // 预热 dataApi（与 initRole 并发 cold-start）：让首个业务调用命中热实例，避免首屏连排冷启动卡顿
    callApi('ping').catch(() => {});
    // 后台连通性探测（前端已全面走云函数，preflight 为空操作）
    preflight().catch(() => {});
    // 上架合规（2026-11-12）：隐私授权守卫。
    // MP 后台配置《小程序隐私保护指引》后，调用相册选图等隐私接口前微信会触发此回调，
    // 需由小程序弹确认框并 resolve('agree') 才放行；旧基础库 / 未配置指引时自动跳过，不阻断业务。
    try {
      if (typeof wx.onNeedPrivacyAuthorization === 'function') {
        wx.onNeedPrivacyAuthorization((resolve) => {
          wx.showModal({
            title: '隐私保护提示',
            content: '使用相册选图等功能前，请先阅读并同意《隐私政策》（可在「关于我们 → 隐私政策」查看）。',
            confirmText: '同意并继续',
            cancelText: '暂不同意',
            success: (r) => {
              if (r.confirm) resolve({ buttonId: 'agree-btn', event: 'agree' });
              else resolve({ event: 'disagree' });
            },
            fail: () => resolve({ event: 'disagree' }),
          });
        });
      }
    } catch (e) { /* 兼容旧基础库，忽略 */ }
  },

  // 基于微信 OPENID 静默判定角色：调 whoami，云函数用上下文 OPENID 查 staff 返回 role。
  // OPENID 在云函数上下文自动可用，无需匿名登录/账号密码，顾客与商家都无感。
  async initRole() {
    let role = 'guest';
    let uid = '';
    try {
      const me = await callApi('whoami');
      uid = (me && me.openid) || '';
      role = (me && me.role) || 'guest';
      console.log('[role] openid =', uid, 'role =', role);
    } catch (e) {
      console.warn('[role] whoami 失败，降级为顾客', e);
    }
    // 一次性老板身份采集：尚未登记为员工/老板(guest)时，静默把当前 OPENID 上报到 owner_boot，
    // 由管理员从云端读取后显式写入 staff(manager)。后台上报，不阻塞、失败忽略。
    if (role === 'guest' && uid) {
      ownerBoot().catch(() => {});
    }
    // 本机老板解锁兜底（隐藏长按入口 bindBoss 成功后写入）：优先于云端判定
    if (wx.getStorageSync('bossUnlocked') === '1') role = 'manager';
    this.globalData.uid = uid;
    this.globalData.role = role;
  },

  // 本机老板解锁：隐藏长按入口 bindBoss 成功后调用，标记本机为店长（写入本地存储，持久生效）
  unlockBoss() {
    wx.setStorageSync('bossUnlocked', '1');
    this.globalData.role = 'manager';
    // 通知所有 tabBar 重新渲染
    const pages = getCurrentPages();
    if (pages && pages.length) {
      const cur = pages[pages.length - 1];
      if (cur && cur.getTabBar && cur.getTabBar()) cur.getTabBar().sync();
    }
  },

  // 取消本机老板解锁（恢复正常角色判定）
  lockBoss() {
    wx.removeStorageSync('bossUnlocked');
    this.globalData.role = '';
    this.refreshRole();
  },

  // 页面 onShow 时调用：角色尚未确定('')则重新拉取
  refreshRole() {
    if (this.globalData.role === '') return this.initRole();
    return Promise.resolve(this.globalData.role);
  },
});

// ===== 全局注入 isTablet 到每个页面 data（无需逐页改 JS）=====
// 微信 WXSS 的 @media(min-width) 宽度查询在真机/模拟器经常不触发，故改用 JS 判定 + 挂 .is-tablet 类，
// 类选择器 100% 生效；手机 isTablet=false 不挂类，样式零变化。
(function () {
  const _Page = Page;
  Page = function (opts) {
    opts.data = Object.assign({}, opts.data, { isTablet: detectTablet() });
    const origOnLoad = opts.onLoad;
    opts.onLoad = function (q) {
      const t = detectTablet();
      this.setData({ isTablet: t });
      console.log('[tablet] isTablet =', t);
      if (origOnLoad) origOnLoad.call(this, q);
    };
    return _Page(opts);
  };
})();
