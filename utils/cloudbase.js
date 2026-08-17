// CloudBase 初始化（小程序端，CommonJS 写法，配合「关闭增强编译」）
// 关闭增强编译后，npm 包用 require 引入；SDK 默认导出可能在 .default 上，做兼容。
require('./runtime.js'); // 提供 async/await 运行时（关掉增强编译后必需）

// 直接 require 已构建的 miniprogram_npm 产物（相对路径），绕开部分微信开发者工具版本
// （如 2.01.2510290）SummerCompiler 崩溃导致「包名→miniprogram_npm」解析未完成、require 失败的问题。
// 若日后开发者工具恢复正常，本写法依然有效（miniprogram_npm 始终存在）。
const _cb = require('../miniprogram_npm/@cloudbase/js-sdk/index.js');
const cloudbase = _cb.default || _cb;
let _adapterMod = require('../miniprogram_npm/@cloudbase/adapter-wx_mp/index.js');
let adapter = _adapterMod.default || _adapterMod;

const { ENV, REGION } = require('./config');

let _app = null;
let _auth = null;
let _initError = null;
let _warned = false;

// 把错误归类，给出可操作的排查建议（中文）
// 2026-08-16：数据层已全面改为「云函数 dataApi 代理 cloud1 文档库」，前端不再直连 rdb/PG，
// 故错误分类聚焦：网络/域名、云函数、鉴权（CloudBase Auth 匿名/密码）、集合权限。
function classifyError(e) {
  const msg = String((e && (e.message || e.stack)) || e);
  let category = 'unknown';
  let hint = '请把此弹窗内容截图发给我，或把 Console 里 [menu] / [role] 的报错发给我，我可精确定位。';
  if (/headers\.get is not a function|fetch is not a function|is not a function|Cannot read propert/i.test(msg)) {
    category = 'transport';
    hint = '小程序端缺少网络传输层（adapter 未生效）。请确认：①已「构建 npm」；②依赖为 @cloudbase/js-sdk + @cloudbase/adapter-wx_mp；③微信开发者工具「详情→本地设置」勾选「不校验合法域名」。';
  } else if (/url|domain|request|ENOTFOUND|getaddrinfo|net::|ERR_|timeout|timed out|连接|网络|fail/i.test(msg)) {
    category = 'network';
    hint = '网络 / 域名被拦截。请在微信开发者工具右上角「详情→本地设置」勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」。正式发布前需在小程序后台「开发→开发设置→服务器域名」添加正确的 request 合法域名。';
  } else if (/401|unauthorized|unauthenticated|签名|signature|sign|accesskey|invalid|无效|拒绝|forbidden|403|not allowed|登录|auth/i.test(msg)) {
    category = 'auth';
    hint = '鉴权失败。请确认云端环境已开启「匿名登录」（顾客/角色识别需要），以及商家登录所需的「账号密码登录」。';
  } else if (/collection|does not exist|不存在|does not have|权限|permission|denied|deny|role/i.test(msg)) {
    category = 'db';
    hint = '数据库集合 / 权限问题。请确认云端已创建对应集合（dishes / orders / rooms / bookings / staff 等），且 dataApi 等云函数已「上传并部署：云端安装依赖」。';
  }
  return { category, hint, msg };
}

function registerAdapter() {
  if (!adapter) { console.warn('[cloudbase] 未找到 adapter 模块'); return false; }
  // SDK 内部按数组遍历 isMatch，优先数组形式
  try {
    if (cloudbase.useAdapters) {
      cloudbase.useAdapters([adapter]);
      console.log('[cloudbase] adapter 已注册（数组形式），runtime=', cloudbase.Platform && cloudbase.Platform.runtime);
      return true;
    }
  } catch (e1) {
    console.warn('[cloudbase] useAdapters(数组) 失败，尝试单个：', e1);
  }
  try {
    if (cloudbase.useAdapters) {
      cloudbase.useAdapters(adapter);
      console.log('[cloudbase] adapter 已注册（单个形式）');
      return true;
    }
  } catch (e2) {
    console.warn('[cloudbase] useAdapters(单个) 也失败：', e2);
  }
  return false;
}

function ensureApp() {
  if (_app) return _app;
  if (_initError) throw _initError;
  try {
    console.log('[cloudbase] 运行环境: wx=', typeof wx, '| useAdapters=', typeof cloudbase.useAdapters,
      '| adapter=', adapter && (adapter.name || Object.prototype.toString.call(adapter)));
    registerAdapter();
    _app = cloudbase.init({ env: ENV, region: REGION });
    console.log('[cloudbase] init 成功');
    return _app;
  } catch (e) {
    _initError = e;
    if (!_warned) {
      _warned = true;
      const d = classifyError(e);
      setTimeout(() => {
        try {
          wx.showModal({
            title: '云端初始化失败（' + d.category + '）',
            content: String(d.msg).slice(0, 500) + '\n\n排查建议：\n' + d.hint,
            showCancel: false,
          });
        } catch (_) { /* wx 未就绪时忽略 */ }
      }, 400);
    }
    throw e;
  }
}

function getAuth() {
  const a = ensureApp();
  if (!_auth) _auth = a.auth;
  return _auth;
}

// 供 app.js 主动触发初始化（失败已内部处理，不会抛出中断）
function ensureCloud() {
  try { ensureApp(); return true; } catch (e) { return false; }
}

// 后台探测：前端已全面改为云函数中转（dataApi），不再直连数据库；连通性由云函数保证，此探测改为空操作。
async function preflight() {
  return { ok: true, category: 'ok', hint: '', msg: '前端已全面走云函数，无需直连探测' };
}

// auth 惰性代理：仅商家/员工登录（signInWithPassword）和匿名登录（角色识别）使用 CloudBase Auth。
const auth = new Proxy({}, {
  get(_t, prop) {
    const v = getAuth()[prop];
    return typeof v === 'function' ? v.bind(getAuth()) : v;
  },
});

module.exports = { ensureCloud, auth, getAuth, classifyError, preflight };
