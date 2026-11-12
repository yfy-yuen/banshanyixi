const core = require('../core');
// 深拷贝 data，避免 5 个页面共享 core.data 里的数组/对象引用
Page(Object.assign({}, core, {
  data: Object.assign(JSON.parse(JSON.stringify(core.data)), { tab: 'orders' }),
}));
