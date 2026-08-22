// 云端与业务配置（与 Web 版一致）
// 2026-08-16：切回 cloud1（小程序 AppID 实际归属账号 B），数据库由 PostgreSQL 改为微信云开发文档库（集合）。
const ENV = 'cloud1-d9gs6p6t18e19cff9';
const REGION = 'ap-shanghai';

// 包厢（与 Web 版一致，无 4 号）
const ROOMS = { '1': '谷山玥', '2': '满仓', '3': '枕山', '5': '云起', '6': '知来' };

/* 老板身份现已改为云端 staff.openid(OPENID) 静默判定（见 app.js initRole + 云函数 whoami），
 * 不再依赖此处硬编码的匿名 uid。该常量已弃用，保留说明以免误用。 */

/* 老板一次性注册解锁码：开门页长按印章（隐藏入口）输入此码 → 云函数 bindBoss 把当前微信 OPENID
 * 写入 staff(role:manager)，之后全自动识别，无需再输。与云端正式途径并存。 */
const BOSS_CODE = 'Boss8888';

/* ⚠️⚠️ 受保护常量（绝对禁止改）：开门视频源 + 封面。
 * 用户 2026-08-17 深夜确认开门视频（H.264 编码、黑屏已修复）效果满意并【锁死】：
 * 除非用户**明确点名**要换/改开门视频或封面，否则**任何指令都不得修改** GATE_VIDEO_SRC / GATE_VIDEO_POSTER
 * ——即便用户说"自规划内容""按你感觉改""除 XX 外都改"等泛指授权，也**不包括**此项。
 * 配套云存储文件 gate/door-open.mp4、gate/door-poster.jpg 同样锁定，不要重新上传覆盖。 */
/* 开门视频（最终方案）：用真实质感的"开门"视频做开门页，覆盖之前的 CSS 木门。
 * 2026-08-17 用户发来本地一段开门视频（山坡老木门质感），已转码 H.264 并上传至云存储 gate/door-open.mp4 覆盖旧素材。
 * 视频不可用（加载/播放失败）时页面自动退回 CSS 静态兜底，不会黑屏卡死。 */
const GATE_VIDEO_SRC = 'cloud://cloud1-d9gs6p6t18e19cff9.636c-cloud1-d9gs6p6t18e19cff9-1469520573/gate/door-open.mp4';
// 从 gate/door-open.mp4 中抽取的封面：门关着、中间透出一线金光，最契合"推门入席"仪式感。
// 同样需要经 getTempFileURL 转成 https 后再交给 <video poster>。
const GATE_VIDEO_POSTER = 'cloud://cloud1-d9gs6p6t18e19cff9.636c-cloud1-d9gs6p6t18e19cff9-1469520573/gate/door-poster.jpg';

// 菜品分类（与真实菜单对应）
const CATS = ['招牌', '凉菜', '海鲜', '河鲜', '家禽', '热菜', '素菜', '汤品', '点心', '饮品', '酒水', '其他'];

/* 微信订阅消息模板 ID（预订确认推送用）。
 * 模板：宴席预定即将到时提醒（关键词：预定日期 / 宾客人数 / 宴席类型 / 预定宴会厅）。
 * 必填才能实际推送：① 此处填模板 ID；② 同时在 dataApi 云函数环境变量设同名 RESERVE_TPL_ID（云端 openapi 发送侧读取 process.env.RESERVE_TPL_ID）。
 * 两处 ID 必须一致。留空 '' 时：顾客端不弹授权、店务确认也不发推送（不会报错）。
 * 云端 confirmReservation 发送侧字段代号（date1/number2/thing3/thing4）以 MP 后台「我的模板」显示的为准；若代号与此不同，改 dataApi 第 428-432 行的 data 字段即可。 */
const RESERVE_TPL_ID = 'kQPofhWMCtqHYs_DobSxURk0wvQF6k9o0_Rc0O-_uDE';

/* 门店基础信息（about 页导航/拨号用）。顾客端 about 页从此处集中读取，避免硬编码散落。
 * STORE_ADDR：门店地址（导航显示名）
 * STORE_PHONE：门店电话（一键拨打；多个号码用 / 分隔，拨号时取第一个）
 * STORE_LAT / STORE_LNG：GCJ-02 经纬度（微信发位置/腾讯位置服务坐标拾取器获取；0 表示未设置，导航提示「门店位置待补充」） */
const STORE_ADDR = '湖南省长沙市望城区雷锋大道悦禧山庄山坡22号半山一席';
const STORE_PHONE = '13055195558/18674843777';  // 多个号码用 / 分隔，拨号取第一个
const STORE_LAT = 28.260397;         // GCJ-02 纬度（腾讯地图坐标，悦禧国际山庄参考点）
const STORE_LNG = 112.883721;        // GCJ-02 经度（腾讯地图坐标，悦禧国际山庄参考点）
const STORE_NAME = '半山一席';   // 工商注册名（导航/拨号显示用，无间隔点）；品牌视觉仍用「半山·一席」

// 预点菜自助修改截止线：用餐日 00:00 往前数 N 个整天。
// 规则：距用餐日 < N 整天（即用餐当天 / 前 1 天 / 不足 N 天）则锁定，只能联系店员代加。
// 例：用餐周六 → 周三(前3天)仍可改，周四00:00起锁定（PREORDER_LOCK_DAYS=2 表示「至少提前 2 整天」）。
const PREORDER_LOCK_DAYS = 2;

// 判断顾客能否自助修改预点菜（仅针对「已有预订」的改预点场景；首次创建下单不受限）。
// date: 用餐日期 'YYYY-MM-DD'。返回 true=可自助改；false=已锁定。
function canSelfEditPreorder(date) {
  if (!date) return true; // 缺日期时保守放开，由后端兜底
  const now = new Date();
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return true;
  const mealDay = new Date(y, m - 1, d, 0, 0, 0, 0); // 用餐日 00:00
  const diffMs = mealDay.getTime() - now.getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  return diffDays >= PREORDER_LOCK_DAYS;
}

// 工具函数
const fmt = (n) => '¥' + Number(n || 0).toFixed(2);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

module.exports = { ENV, REGION, ROOMS, BOSS_CODE, CATS, fmt, genId, GATE_VIDEO_SRC, GATE_VIDEO_POSTER, RESERVE_TPL_ID, STORE_ADDR, STORE_PHONE, STORE_LAT, STORE_LNG, STORE_NAME, PREORDER_LOCK_DAYS, canSelfEditPreorder };
