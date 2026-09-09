// 平板判定辅助（逻辑宽 >= 600 视为平板）
function detectTablet() {
  try {
    const info = wx.getSystemInfoSync();
    return (info.windowWidth || info.screenWidth || 0) >= 600;
  } catch (e) { return false; }
}

module.exports = { detectTablet };
