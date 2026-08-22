const { CATS } = require('../../utils/config');
const { loadDishes } = require('../../utils/api');
const { classifyError } = require('../../utils/cloudbase');

// 只读菜单浏览页：底部 tabBar 入口，所有人可见，仅查看不能点单。
// 布局与 pages/menu/menu 保持一致（左栏分类 + 右侧分区），但无购物车/搜索/加减。

const TAG_MAP = {
  '招牌': { cls: 'b-sign', label: '招牌' },
  '辣': { cls: 'b-spicy', label: '辣' },
  '素': { cls: 'b-veg', label: '素' },
  '时令': { cls: 'b-season', label: '时令' },
};

function badgesOf(d) {
  if (!Array.isArray(d.tags)) return [];
  return d.tags.map((t) => TAG_MAP[t]).filter(Boolean);
}

Page({
  data: {
    cats: [],
    activeCat: '',
    sections: [],
    scrollIntoId: '',
    allDishes: [],
    showSearch: false,
    searchKeyword: '',
    searchResults: [],
  },
  onLoad() {
    this.loadMenu();
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selectedKey: 'menu' });
    }
  },
  async loadMenu() {
    wx.showLoading({ title: '加载菜单' });
    try {
      const raw = await loadDishes();
      const dishes = raw.map((d) => ({
        ...d,
        ph: (d.name || '?').charAt(0),
        badges: badgesOf(d),
      }));
      const sections = CATS.map((cat) => {
        const items = dishes.filter((d) => d.category === cat);
        return { cat, items };
      }).filter((s) => s.items.length > 0);
      this.setData({
        allDishes: dishes,
        sections,
        cats: sections.map((s) => s.cat),
        activeCat: sections[0]?.cat || '',
      });
      wx.hideLoading();
    } catch (e) {
      console.error('[dishes] 菜单加载失败:', e);
      const d = classifyError(e);
      console.warn('[dishes] 诊断:', JSON.stringify(d));
      wx.hideLoading();
      const content = String(d.msg).slice(0, 400) + (d.hint ? '\n\n排查建议：\n' + d.hint : '');
      wx.showModal({
        title: '菜单加载失败（' + d.category + '）',
        content,
        confirmText: '重试',
        cancelText: '知道了',
        success: (res) => { if (res.confirm) this.loadMenu(); },
      });
    }
  },
  setCat(e) {
    const cat = e.currentTarget.dataset.cat;
    const idx = this.data.cats.indexOf(cat);
    this.setData({ activeCat: cat, scrollIntoId: 'dsec-' + idx });
  },

  /* ===== 搜索（只读，无加购） ===== */
  openSearch() { this.setData({ showSearch: true, searchKeyword: '', searchResults: [] }); },
  closeSearch() { this.setData({ showSearch: false, searchKeyword: '', searchResults: [] }); },
  onSearchInput(e) {
    const raw = e.detail.value || '';
    const kw = raw.trim().toLowerCase();
    this.setData({ searchKeyword: raw });
    this.runSearch(kw);
  },
  runSearch(kw) {
    if (!kw) { this.setData({ searchResults: [] }); return; }
    const res = this.data.allDishes.filter((d) =>
      (d.name || '').toLowerCase().includes(kw) ||
      (d.tags || []).join(',').toLowerCase().includes(kw) ||
      (d.description || '').toLowerCase().includes(kw)
    );
    this.setData({ searchResults: res });
  },
  noop() {},

  // 跳转门店信息页
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },

  onPanelScroll() {
    const query = wx.createSelectorQuery().in(this);
    query.selectAll('.sec').boundingClientRect();
    query.exec((res) => {
      const rects = res[0];
      if (!rects || !rects.length) return;
      let current = this.data.cats[0];
      for (let i = 0; i < rects.length; i++) {
        if (rects[i].top <= 150) current = this.data.cats[i];
      }
      if (current && current !== this.data.activeCat) {
        this.setData({ activeCat: current });
      }
    });
  },
});
