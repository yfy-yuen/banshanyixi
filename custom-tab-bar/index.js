// 半山·一席 自定义 TabBar：按微信身份(RBAC)渲染可见标签
// 顾客(guest) 见「包厢/菜单/我的」；店员/店长(clerk/manager) 多一个「店务」
// 商家后台 / 后厨 / 包厢编辑已移入 staff 分包，由店务页进入，不在底部渲染
// 菜单为只读浏览页，所有人可见；真正的点单在包厢内跳转的 pages/menu/menu
const ROLE_TABS = {
  guest: ['rooms', 'menu', 'mine'],
  clerk: ['rooms', 'menu', 'mine', 'book'],
  manager: ['rooms', 'menu', 'mine', 'book'],
};
const META = {
  rooms: { pagePath: '/pages/rooms/rooms', text: '包厢' },
  menu: { pagePath: '/pages/dishes/dishes', text: '菜单' },
  mine: { pagePath: '/pages/mine/mine', text: '我的' },
  book: { pagePath: '/pages/book/book', text: '店务' },
};

Component({
  data: {
    role: 'guest',
    tabs: [{ key: 'rooms', ...META.rooms }],
    selectedKey: 'rooms',
    isTablet: false,
  },
  lifetimes: {
    attached() { this.sync(); this.detectTablet(); },
  },
  pageLifetimes: {
    show() { this.sync(); },
  },
  methods: {
    detectTablet() {
      try {
        const info = wx.getSystemInfoSync();
        this.setData({ isTablet: (info.windowWidth || info.screenWidth || 0) >= 600 });
      } catch (e) { this.setData({ isTablet: false }); }
    },
    sync() {
      const app = getApp();
      if (!app) return;
      const role = app.globalData.role;
      const finish = () => {
        this.applyTabs(app.globalData.role);
        // 根据当前页面路由高亮对应 tab，避免与页面 onShow 设置 selectedKey 产生竞态覆盖
        const pages = getCurrentPages();
        const route = (pages[pages.length - 1] && pages[pages.length - 1].route) || '';
        const found = Object.keys(META).find((k) => META[k].pagePath.replace(/^\//, '') === route);
        this.setData({ selectedKey: found || this.data.selectedKey || 'rooms' });
      };
      if (role === '') {
        // 角色尚未初始化：等拉取完成后再渲染
        if (app.refreshRole) app.refreshRole().then(finish);
        return;
      }
      finish();
    },
    applyTabs(role) {
      const keys = ROLE_TABS[role] || ROLE_TABS.guest;
      const tabs = keys.map((k) => ({ key: k, ...META[k] }));
      this.setData({ role, tabs });
    },
    switchTab(e) {
      const key = e.currentTarget.dataset.key;
      this.setData({ selectedKey: key });
      wx.switchTab({ url: META[key].pagePath });
    },
  },
});
