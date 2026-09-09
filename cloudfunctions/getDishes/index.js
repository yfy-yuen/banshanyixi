// 查询菜单菜品（CloudBase PG HTTP API 版）
// @cloudbase/node-sdk 的 app.rdb() 在云函数里仍试图走 pg TCP，连接失败；
// 改用 CloudBase PG 官方 REST API（PostgREST 风格），用 API Key（service_role）鉴权。
const https = require('https');

const ENV_ID = process.env.ENV_ID || 'yuen-cloud-d9g0mo1bv654d2ff6';
const API_KEY = process.env.API_KEY;
const BASE_URL = `https://${ENV_ID}.api.tcloudbasegateway.com`;

function request(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = https.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => {
          try {
            const data = chunks ? JSON.parse(chunks) : null;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
            }
          } catch (e) {
            reject(new Error(`parse error: ${chunks}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

exports.main = async () => {
  try {
    if (!API_KEY) throw new Error('缺少 API_KEY 环境变量');
    const rows = await request('/v1/rdb/rest/dishes?select=*&order=price.asc');
    return { data: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    console.error('[getDishes] exception:', e.message);
    return { error: e.message || '查询菜品失败' };
  }
};
