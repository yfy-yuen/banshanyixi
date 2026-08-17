require('./utils/runtime.js'); // 提供 async/await 运行时（关闭增强编译后必需）
const { ensureCloud, preflight } = require('./utils/cloudbase');
const { callApi, ownerBoot } = require('./utils/api');
const { ENV } = require('./utils/config'); // ENV 用于初始化微信云能力

App({
  globalData: {
    roomNo: '',
    roomName: '',
    people: 1,
    uid: '',          // 微信 OPENID（云函数上下文自动附带，稳定身份，作为 staff 锚定）
    role: '',         // ''=加载中 | 'guest' | 'clerk' | 'manager'
  },
  onLaunch() {
    // 初始化微信原生云能力（顾客/下单/查询统一经云函数调用，云函数再访问 cloud1 文档库）
    try { wx.cloud.init({ env: ENV, traceUser: false }); } catch (e) { console.warn('[app] wx.cloud.init 已初始化或失败', e); }
    // 恢复上次选择的包厢
    const roomNo = wx.getStorageSync('roomNo');
    const roomName = wx.getStorageSync('roomName');
    if (roomNo) {
      this.globalData.roomNo = roomNo;
      this.globalData.roomName = roomName;
    }
    // 预初始化云端
    ensureCloud();
    // 微信身份 + 角色（顾客 / 店员 / 店长）——基于 OPENID 静默判定，无需登录框
    this.initRole();
    // 后台连通性探测（前端已全面走云函数，preflight 为空操作）
    preflight().catch(() => {});
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
