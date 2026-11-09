/**
 * 简单IndexedDB封装，用来存视频File对象，刷新后自动恢复
 */
const DB_NAME = 'wxhb_db';
const STORE_NAME = 'files';

let dbInstance = null;
let opening = null;

export async function openDB() {
  if (dbInstance) return dbInstance;
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => {
      dbInstance = e.target.result;
      dbInstance.onversionchange = () => { dbInstance.close(); dbInstance = null; };
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error || new Error('素材数据库打开失败'));
  });
  try { return await opening; }
  finally { opening = null; }
}

/** 存文件：key是节点id，value是File对象 */
export async function saveFile(key, file) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id: key, file: file });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('素材写入未完成'));
  });
}

/** 读文件：根据key取File对象 */
export async function getFile(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = (e) => resolve(e.target.result?.file || null);
    req.onerror = () => reject(req.error || new Error('素材读取失败'));
    tx.onabort = () => reject(tx.error || new Error('素材读取被中断'));
  });
}

/** 删除文件 */
export async function deleteFile(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('素材删除未完成'));
  });
}
