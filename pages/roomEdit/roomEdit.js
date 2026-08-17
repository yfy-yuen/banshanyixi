const { ROOMS } = require('../../utils/config');
const { getRoom, saveRoom } = require('../../utils/api');

// 抽取 HTML 中所有 cloud:// 图片 src（富文本插图以 cloud:// 永久存储，显示时再转临时链）
function parseCloudImgs(html) {
  const re = /<img[^>]+src=["']([^"']*cloud:\/\/[^"']*)["']/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

Page({
  data: {
    roomNo: '', roomName: '',
    envPhotos: [],   // 环境照：cloud:// fileID 数组（<image> 可直接渲染）
    saving: false,
  },
  onLoad(options) {
    const no = options.room || '';
    const name = ROOMS[no] || ('厢' + no);
    this._map = {};  // cloud:// -> https 临时链（编辑器预览用）
    this._rev = {};  // https 临时链 -> cloud://（保存时还原，避免临时链过期）
    this._pendingIntro = '';
    this.setData({ roomNo: no, roomName: name });
    this.loadRoom(no);
  },

  async loadRoom(no) {
    try {
      const room = await getRoom(no);
      const env = (room && room.env_photos) || [];
      let introHtml = (room && room.intro) || '';
      if (introHtml) {
        // 把存储的 cloud:// 插图换成临时 https 链，供编辑器预览
        const clouds = [...new Set(parseCloudImgs(introHtml))];
        if (clouds.length) {
          const r = await new Promise((res) => wx.cloud.getTempFileURL({ fileList: clouds, success: res, fail: res }));
          (r.fileList || []).forEach((f) => {
            if (f.tempFileURL) { this._map[f.fileID] = f.tempFileURL; this._rev[f.tempFileURL] = f.fileID; }
          });
          clouds.forEach((c) => { if (this._map[c]) introHtml = introHtml.split(c).join(this._map[c]); });
        }
      }
      this.setData({ envPhotos: env });
      this._pendingIntro = introHtml; // 等编辑器 ready 再写入
    } catch (e) { console.warn('[roomEdit] loadRoom', e); }
  },

  // 编辑器就绪：建上下文 + 回填已存介绍
  editorReady() {
    this.editorCtx = wx.createEditorContext('editor', this);
    if (this._pendingIntro) {
      this.editorCtx.setContents({ html: this._pendingIntro });
      this._pendingIntro = '';
    }
  },

  /* ===== 环境照：上传 / 移动排序 / 删除 ===== */
  async chooseEnv() {
    const r = await new Promise((res) => wx.chooseMedia({
      count: 9, mediaType: ['image'], sizeType: ['compressed'], success: res, fail: res,
    }));
    if (!r || !r.tempFiles) return;
    wx.showLoading({ title: '上传中' });
    try {
      const no = this.data.roomNo;
      const added = [];
      for (const f of r.tempFiles) {
        const ext = (f.tempFilePath.split('.').pop() || 'jpg').split('?')[0];
        const cloudPath = `rooms/${no}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const up = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath });
        if (up && up.fileID) added.push(up.fileID);
      }
      this.setData({ envPhotos: this.data.envPhotos.concat(added) });
    } catch (e) {
      wx.showToast({ title: '上传失败', icon: 'none' });
    } finally { wx.hideLoading(); }
  },
  moveEnv(e) {
    const i = Number(e.currentTarget.dataset.index);
    const dir = e.currentTarget.dataset.dir;
    const arr = this.data.envPhotos.slice();
    const j = i + (dir === 'left' ? -1 : 1);
    if (j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    this.setData({ envPhotos: arr });
  },
  deleteEnv(e) {
    const i = Number(e.currentTarget.dataset.index);
    const arr = this.data.envPhotos.slice();
    arr.splice(i, 1);
    this.setData({ envPhotos: arr });
  },

  /* ===== 富文本工具栏 ===== */
  format(e) {
    const cmd = e.currentTarget.dataset.cmd;
    const ctx = this.editorCtx;
    if (!ctx) return;
    if (cmd === 'bold') ctx.format('bold');
    else if (cmd === 'italic') ctx.format('italic');
    else if (cmd === 'underline') ctx.format('underline');
    else if (cmd === 'strike') ctx.format('strike');
    else if (cmd === 'h1') ctx.format('header', 'h1');
    else if (cmd === 'h2') ctx.format('header', 'h2');
    else if (cmd === 'p') ctx.format('header', 'p');
    else if (cmd === 'ul') ctx.format('list', 'unordered');
    else if (cmd === 'ol') ctx.format('list', 'ordered');
    else if (cmd === 'align-left') ctx.format('align', 'left');
    else if (cmd === 'align-center') ctx.format('align', 'center');
    else if (cmd === 'align-right') ctx.format('align', 'right');
    else if (cmd === 'clear') ctx.removeFormat();
  },
  async insertImg() {
    const r = await new Promise((res) => wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'], success: res, fail: res,
    }));
    if (!r || !r.tempFiles || !r.tempFiles[0]) return;
    wx.showLoading({ title: '上传中' });
    try {
      const no = this.data.roomNo;
      const f = r.tempFiles[0];
      const ext = (f.tempFilePath.split('.').pop() || 'jpg').split('?')[0];
      const cloudPath = `rooms/${no}/intro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath });
      const fileID = up.fileID;
      const t = await new Promise((res) => wx.cloud.getTempFileURL({ fileList: [fileID], success: res, fail: res }));
      const temp = (t.fileList && t.fileList[0] && t.fileList[0].tempFileURL) || '';
      if (temp) {
        this._map[fileID] = temp;
        this._rev[temp] = fileID;
        this.editorCtx.insertImage({ src: temp, alt: '图片', width: '100%', success: () => {} });
      } else {
        wx.showToast({ title: '图片链接获取失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '插入失败', icon: 'none' });
    } finally { wx.hideLoading(); }
  },

  /* ===== 保存 ===== */
  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中' });
    try {
      const html = await new Promise((res) => {
        this.editorCtx.getContents({ success: (r) => res(r.html || ''), fail: () => res('') });
      });
      // 编辑器里的临时 https 链还原为 cloud:// 永久存储
      let out = html;
      Object.keys(this._rev).forEach((temp) => { out = out.split(temp).join(this._rev[temp]); });
      await saveRoom(this.data.roomNo, this.data.envPhotos, out);
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '保存失败：' + (e.message || ''), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
