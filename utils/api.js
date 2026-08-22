// 数据层：所有云端读写统一经云函数 dataApi（代理 cloud1 文档库），前端不直接连数据库
// 角色判定走云函数 whoami（基于微信 OPENID 静默返回 role），无需登录框。

// 统一调用 dataApi 云函数；result.error 视为业务失败并抛错
// 自动重试：云函数冷启动（久未调用首次拉容器 2~8s）偶发超时，重试可自愈
async function callApi(action, payload, attempt = 0) {
  try {
    const { result } = await wx.cloud.callFunction({ name: 'dataApi', data: { action, ...(payload || {}) } });
    if (!result || result.error) throw new Error((result && result.error) || '请求失败');
    return result.data;
  } catch (e) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 600));
      return callApi(action, payload, attempt + 1);
    }
    throw e;
  }
}

/* ===== 身份 / 角色 ===== */
// 静默取当前微信身份与角色（OPENID 由云函数上下文自动附带）
async function whoami() {
  return (await callApi('whoami')) || { openid: '', role: 'guest' };
}
// 隐藏长按入口：输解锁码一次性注册老板（云端把当前 OPENID 写入 staff(manager)）
async function bindBoss(code) {
  return await callApi('bindBoss', { code });
}
// 一次性老板身份采集：把当前微信 OPENID 上报到 owner_boot（由云端管理员读取后写入 staff）
async function ownerBoot() {
  return await callApi('ownerBoot');
}

/* ===== 顾客端 ===== */
// 读取可点菜品（公开接口，过滤下架）
async function loadDishes() {
  const data = await callApi('dishes');
  return (data || []).filter((d) => d.available !== false);
}

// 提交订单（走独立 submitOrder 云函数）
async function submitOrder({ roomNo, roomName, people, items, total, note }) {
  const { result } = await wx.cloud.callFunction({
    name: 'submitOrder',
    data: { roomNo, roomName, people, items, total, note },
  });
  if (!result || result.error) throw new Error((result && result.error) || '提交订单失败');
}

// 本包厢订单（按 room_no）
async function getOrdersByRoom(roomNo) {
  return (await callApi('ordersByRoom', { roomNo })) || [];
}

// 本包厢订单数（角标）
async function getOrderCount(roomNo) {
  const list = await getOrdersByRoom(roomNo);
  return list.length;
}

// 按包厢名取现场下单菜品（room 内页「现场下单」段用）
async function getOrdersByRoomName(roomName) {
  return (await callApi('ordersByRoomName', { roomName })) || [];
}

/* ===== 商家端：订单（店员/老板） ===== */
async function getMerchantOrders() {
  return (await callApi('merchantOrders')) || [];
}

async function settleOrder(id, paymentMethod) {
  await callApi('settleOrder', { id, paymentMethod });
}

// 结账清台：一步完成支付+开收据+closed；paymentMethod 可选（现金cash/扫码scan/记账credit），不传则用订单已有值
async function clearOrder(id, paymentMethod) {
  await callApi('clearOrder', { id, paymentMethod: paymentMethod || '' });
}
// 老板：电子收据列表（结论 #E）
async function listReceipts() {
  return (await callApi('listReceipts')) || [];
}
// 老板：补发到店提醒（提前1天 + 2小时，结论 #3）
async function pushReminders() {
  return (await callApi('pushReminders')) || { sent: 0 };
}
// 老板：重置今日售罄/限定标记（每日开门定时，结论 #18尾）
async function resetDailyFlags() {
  return (await callApi('resetDailyFlags')) || { reset: 0 };
}

/* ===== 商家端：菜品（老板专属） ===== */
async function getDishesAdmin() {
  return (await callApi('dishesAdmin')) || [];
}

async function saveDish(id, payload) {
  await callApi('saveDish', { id, payload });
}

async function deleteDish(id) {
  await callApi('deleteDish', { id });
}

/* ===== 商家端：收款码（老板专属） ===== */
async function getPaymentQrcodes() {
  return (await callApi('paymentQrcodes')) || [];
}

async function saveQr(ch, url) {
  await callApi('saveQr', { ch, url });
}

/* ===== 包厢内容（老板专属）：环境照 + 富文本介绍 ===== */
async function getRoom(roomNo) {
  const list = (await callApi('roomGet', { roomNo })) || [];
  return list[0] || null;
}
async function saveRoom(roomNo, envPhotos, intro) {
  return await callApi('saveRoom', { roomNo, envPhotos, intro });
}

/* ===== 预订系统（场次 + 申请制） ===== */
// 顾客：开放场次列表
async function listSessions() {
  return (await callApi('listSessions')) || [];
}
// 顾客：场次详情（菜单快照）
async function sessionDetail(id) {
  return await callApi('sessionDetail', { id });
}
// 顾客：提交订位申请（时间口径改为 date + expectedArrival，见结论 #G）
async function submitReservation({ date, mealTime, expectedArrival, partySize, contactPhone, note, roomNo, dishes }) {
  return await callApi('submitReservation', { date, mealTime, expectedArrival, partySize, contactPhone, note, roomNo, dishes });
}
// 顾客：我的预订
async function myReservations() {
  return (await callApi('myReservations')) || [];
}
// 顾客：读取单条预订（含预点菜）
async function getReservation(id) {
  return (await callApi('getReservation', { id })) || null;
}
// 顾客：保存/修改预点菜
async function savePreorder(id, dishes) {
  return await callApi('savePreorder', { id, dishes });
}
// 顾客：取消
async function cancelReservation(id) {
  await callApi('cancelReservation', { id });
}
// 顾客：到店自动标记（进入自己预订的包厢内页时调用，结论 #1）。roomNo 必传，无包厢上下文传空→后端跳过防误标
async function markArrived(roomNo) {
  return (await callApi('markArrived', { roomNo: roomNo || '' })) || { ok: false, count: 0 };
}
// 店员/老板：发布场次
async function publishSession({ date, mealTime, capacity, note, roomRef }) {
  return await callApi('publishSession', { date, mealTime, capacity, note, roomRef });
}
// 店员/老板：全部预订
async function listReservations() {
  return (await callApi('listReservations')) || [];
}
// 店员/老板：确认（可传 roomId 手动改厢，见结论 #H）
async function confirmReservation(id, roomId) {
  await callApi('confirmReservation', { id, roomId });
}
// 店员/老板：婉拒（可传 reason 文字原因；无可用厢时云端自动换厢，见结论 #4）
async function rejectReservation(id, reason) {
  await callApi('rejectReservation', { id, reason });
}
// 店员/老板：关场
async function closeSession(id) {
  await callApi('closeSession', { id });
}
// 店员/老板：代客改预点菜（结论 #5：顾客锁定后商家可改）
async function updateReservationDishes(id, dishes) {
  await callApi('updateReservationDishes', { id, dishes });
}
// 老板：清理过期 pending 申请（创建超 24h 仍未处理的预订标记为 cancelled，结论 #10 配套）
async function sweepPending() {
  return (await callApi('sweepPending')) || { cancelled: 0 };
}
// 店员/老板：全部场次（含已关），店务管理用
async function sessionsAdmin() {
  return (await callApi('sessionsAdmin')) || [];
}

module.exports = {
  loadDishes, submitOrder, getOrdersByRoom, getOrderCount, getOrdersByRoomName,
  whoami, bindBoss, ownerBoot,
  getMerchantOrders, settleOrder, clearOrder, listReceipts, pushReminders, resetDailyFlags,
  getDishesAdmin, saveDish, deleteDish, getPaymentQrcodes, saveQr, callApi,
  getRoom, saveRoom,
  listSessions, sessionDetail, submitReservation, myReservations, getReservation, savePreorder, cancelReservation, markArrived,
  publishSession, listReservations, confirmReservation, rejectReservation, closeSession, sessionsAdmin, updateReservationDishes, sweepPending,
};
