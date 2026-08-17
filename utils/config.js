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

// 工具函数
const fmt = (n) => '¥' + Number(n || 0).toFixed(2);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

module.exports = { ENV, REGION, ROOMS, BOSS_CODE, CATS, fmt, genId, GATE_VIDEO_SRC, GATE_VIDEO_POSTER };
