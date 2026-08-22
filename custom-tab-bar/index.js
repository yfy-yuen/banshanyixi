// 半山·一席 自定义 TabBar：按微信身份(RBAC)渲染可见标签
// 顾客(guest) 见「包厢/菜单」；店员/店长(clerk/manager) 见「包厢/菜单/预定/商家」
// 菜单为只读浏览页，所有人可见；真正的点单在包厢内跳转的 pages/menu/menu
const ROLE_TABS = {
  guest: ['rooms', 'menu', 'mine'],
  clerk: ['rooms', 'menu', 'mine', 'book', 'merchant'],
  manager: ['rooms', 'menu', 'mine', 'book', 'merchant'],
};
const META = {
  rooms: { pagePath: '/pages/rooms/rooms', text: '包厢' },
  menu: { pagePath: '/pages/dishes/dishes', text: '菜单' },
  mine: { pagePath: '/pages/mine/mine', text: '我的' },
  book: { pagePath: '/pages/book/book', text: '店务' },
  merchant: { pagePath: '/pages/merchant/merchant', text: '商家' },
};

Component({
  data: {
    role: 'guest',
    tabs: [{ key: 'rooms', ...META.rooms }],
    selectedKey: 'rooms',
  },
  lifetimes: {
    attached() { this.sync(); },
  },
  pageLifetimes: {
    show() { this.sync(); },
  },
  methods: {
    sync() {
      const app = getApp();
      if (!app) return;
      const role = app.globalData.role;
      if (role === '') {
        // 角色尚未初始化：等拉取完成后再渲染
        if (app.refreshRole) app.refreshRole().then(() => this.applyTabs(app.globalData.role));
        return;
      }
      this.applyTabs(role);
    },
    applyTabs(role) {
      const keys = ROLE_TABS[role] || ROLE_TABS.guest;
      const tabs = keys.map((k) => {
        const t = { key: k, ...META[k] };
        // 店员点进「商家」页只看到订单子 tab，故 tab 文案显示「订单」更准确；老板显示「商家」
        if (k === 'merchant') t.text = role === 'manager' ? '商家' : '订单';
        return t;
      });
      const sel = keys.includes(this.data.selectedKey) ? this.data.selectedKey : 'rooms';
      this.setData({ role, tabs, selectedKey: sel });
    },
    switchTab(e) {
      const key = e.currentTarget.dataset.key;
      this.setData({ selectedKey: key });
      wx.switchTab({ url: META[key].pagePath });
    },
  },
});
