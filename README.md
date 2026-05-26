# LibTV Canvas（本地复刻版）

本地个人使用的无限画布 AI 创作工具，复刻自 LibTV 画布，支持 7 种节点：文本、图片、视频、视频合成、导演台、音频、脚本。

## 快速启动

```powershell
cd s:\AI\libtv
npm install          # 首次安装
npm run dev          # 同时启动前后端
```

- 前端：http://localhost:5173
- 后端：http://localhost:3001

## 配置 Mivo API Key

1. 复制配置模板：

```powershell
Copy-Item server\config.example.json server\config.json
```

2. 编辑 `server\config.json`，填入你的 Mivo 平台 API Key：

```json
{
  "mivoBaseUrl": "https://aigc.xindong.com",
  "mivoApiKey": "你的 API Key",
  "port": 3001,
  "projectsDir": "../projects"
}
```

> Mivo API Key 在 aigc.xindong.com → 账号设置 → Access Key 里获取。

## 功能

| 节点 | 说明 |
|------|------|
| 文本节点 | 剧本、广告词、品牌文案，支持 AI 翻译 |
| 图片节点 | 接 Gemini/GPT/Nanobanana，支持 image2image（上游图连线自动触发） |
| 视频节点 | 接 Seed3D/Seedance，支持图生视频/文生视频 |
| 视频合成 | 多段视频拖入排序后 ffmpeg concat |
| 导演台 | 3D 场景截图作为构图参考（当前占位版，后续加 three-fiber） |
| 音频节点 | TTS / 音乐生成 |
| 脚本节点 | 故事板表格，可 AI 生成镜头，可一键转图片节点 |

### 工具箱（选中图片节点后可用）

- **全景**：全景拓展
- **多角度**：多角度变体
- **打光**：重新打光
- **九宫格**：网格拼接
- **高清**：超分辨率
- **宫格切分**：切分为独立图片节点

## 数据存储

项目数据存在 `projects/` 目录，按项目 UUID 组织，JSON 格式，可手动编辑或备份。

## 注意

- `server/config.json` 含 API Key，已加入 `.gitignore`，不会被提交
- `projects/` 目录（用户数据）同样 gitignore
