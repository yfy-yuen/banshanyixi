// 云端辅助（小程序端，CommonJS 写法，配合「关闭增强编译」）
require('./runtime.js'); // 提供 async/await 运行时（关掉增强编译后必需，自包含无 npm 依赖）

// 2026-11-12 主包瘦身：
// 数据层已全面走 wx.cloud.callFunction('dataApi')，小程序端不需要初始化 @cloudbase/js-sdk。
// 原先本文件静态 require miniprogram_npm/@cloudbase/*，会把 6.6M SDK 及其依赖编译进主包，
// 超过微信 2MB 上限（预览不拦、上传发布时才拦）。编译期会解析 require 的字符串路径，
// 仅用 try/catch 包住并不能避免编译报错，因此这里彻底移除静态依赖，
// 并在 project.config.json 的 packOptions.ignore 中排除 miniprogram_npm/。
// 角色识别走云函数上下文 OPENID 静默判定，全项目没有任何页面使用 CloudBase Auth 登录。

// 把错误归类，给出可操作的排查建议（中文）。纯函数，不依赖任何 SDK。
function classifyError(e) {
  const msg = String((e && (e.message || e.stack)) || e);
  let category = 'unknown';
  let hint = '请把此弹窗内容截图发给我，或把 Console 里 [menu] / [role] 的报错发给我，我可精确定位。';
  if (/headers\.get is not a function|fetch is not a function|is not a function|Cannot read propert/i.test(msg)) {
    category = 'transport';
    hint = '小程序端缺少网络传输层。请确认基础库版本较新，且「详情→本地设置」未开启不兼容的编译选项。';
  } else if (/url|domain|request|ENOTFOUND|getaddrinfo|net::|ERR_|timeout|timed out|连接|网络|fail/i.test(msg)) {
    category = 'network';
    hint = '网络 / 域名被拦截。请在微信开发者工具右上角「详情→本地设置」勾选「不校验合法域名…」；正式发布前在小程序后台配置 request 合法域名。';
  } else if (/401|unauthorized|unauthenticated|签名|signature|sign|invalid|无效|拒绝|forbidden|403|not allowed|登录|auth/i.test(msg)) {
    category = 'auth';
    hint = '鉴权失败。请确认云开发环境可用，且云函数 dataApi 已「上传并部署：云端安装依赖」。';
  } else if (/collection|does not exist|不存在|does not have|权限|permission|denied|deny|role/i.test(msg)) {
    category = 'db';
    hint = '数据库集合 / 权限问题。请确认云端已创建对应集合（dishes / orders / rooms / bookings / staff 等），且 dataApi 已重新部署。';
  }
  return { category, hint, msg };
}

// 供 app.js 调用：原生 wx.cloud 已在 app.onLaunch 里 init，此处无需再做任何事。
// 保留同名导出，避免调用方改动。
function ensureCloud() { return true; }

// 后台探测：前端已全面改为云函数中转（dataApi），连通性由云函数保证，此探测为空操作。
async function preflight() {
  return { ok: true, category: 'ok', hint: '', msg: '前端已全面走云函数，无需直连探测' };
}

// 兼容导出：若将来要启用账号密码登录（CloudBase Auth），需重新引入 SDK，
// 并在 project.config.json 的 packOptions.ignore 中放开 miniprogram_npm/，否则运行时会报此错。
function getAuth() {
  throw new Error('CloudBase Auth 未启用：当前角色识别走云函数 OPENID 静默判定，无需登录');
}
const auth = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    return () => { throw new Error('CloudBase Auth 未启用（' + String(prop) + '）'); };
  },
});

module.exports = { ensureCloud, auth, getAuth, classifyError, preflight };
