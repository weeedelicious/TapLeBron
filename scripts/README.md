# sate TV 工程同步指南

## 数据存储位置
所有工程（图片、视频、项目数据）存储在：
```
d:\AI\liblibtv\projects\
```
可以在 `server\config.json` 的 `projectsDir` 字段修改路径。

---

## 方案 A — 最简单：百度网盘自动同步（推荐）

1. 安装百度网盘 PC 客户端并登录
2. 在百度网盘同步目录（如 `C:\Users\你的用户名\百度网盘`）内创建 `sate-tv-projects` 文件夹
3. 把 `d:\AI\liblibtv\projects\` 的内容**复制**进去
4. 修改 `server\config.json`：
   ```json
   "projectsDir": "C:\\Users\\你的用户名\\百度网盘\\sate-tv-projects"
   ```
5. 重启服务器（`npm run dev`）

**换电脑时**：新电脑安装百度网盘 → 等待同步完成 → 修改 config.json → 完成 ✅

---

## 方案 B — 内置导出/导入（app 内一键操作）

在首页顶部点击：
- **⬇ 导出备份** → 下载包含所有工程的 `.zip` 文件
- **⬆ 导入恢复** → 选择之前导出的 `.zip` 恢复全部工程

适合：换电脑、定期手动备份到本地/云盘

---

## 方案 C — rclone 自动同步（百度网盘/阿里云盘/OneDrive）

### 第一步：配置 rclone

1. 下载 rclone：https://rclone.org/downloads/
2. 把 `rclone.exe` 放到本目录（`scripts\`）
3. 配置百度网盘：
   ```
   scripts\rclone.exe config
   ```
   - 选 `n` 新建
   - 名称输入：`baidu`
   - 类型选：`drive`（百度网盘）或按提示选
   - 按提示在浏览器完成授权

### 第二步：同步到云端

双击 `sync-to-cloud.bat` 即可将所有工程上传到百度网盘。

### 第三步：新电脑恢复

双击 `restore-from-cloud.bat`，输入 `y` 确认，等待下载完成。

### 自动定时同步（可选）

用 Windows 任务计划程序每 30 分钟自动执行：
1. 打开"任务计划程序"
2. 新建基本任务 → 触发器选"每天重复，间隔 30 分钟"
3. 操作选"启动程序" → 选择 `sync-to-cloud.bat`

---

## 脚本配置修改

如果工程目录不在默认位置，修改脚本顶部的配置区：

```bat
set PROJECTS_DIR=d:\AI\liblibtv\projects    ← 改为你的实际路径
set RCLONE_REMOTE=baidu:sate-tv-projects    ← 改为你配置的 remote 名称
```
