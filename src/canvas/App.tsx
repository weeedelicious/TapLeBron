import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "./components/Canvas";
import { TopNav } from "./components/TopNav";
import { ProjectList } from "./components/ProjectList";
import { ReplaceApiKeyDialog } from "./components/ReplaceApiKeyDialog";
import { StudioApp } from "./components/StudioApp";
// 独占画布会话完全由 public/canvas-exclusive-session-*.js 在网络层承担：
// 它拦截 fetch / XMLHttpRequest / EventSource，负责 enter、心跳、令牌、失效阻断页。
// app 这一层不碰会话，也不要再实现一套——两套并存会互相把对方的会话顶掉。
import { accountApi, projectsApi } from "./lib/api";
import {
  CANVAS_CLIENT_ID,
  CANVAS_REMOTE_SYNC_REQUIRED_EVENT,
  hasPendingNodeSaves,
  useCanvasStore,
} from "./store/canvasStore";
import type { Project } from "./lib/types";
import "./styles.css";

const PROJECT_QUERY_KEY = "project";
/** 本页保存没排空时，实时同步隔多久再试一次。 */
const SYNC_RETRY_WHILE_SAVING_MS = 1_200;

function currentProjectIdFromUrl() {
  return new URL(window.location.href).searchParams.get(PROJECT_QUERY_KEY);
}

function syncProjectUrl(
  projectUuid: string | null,
  mode: "push" | "replace" = "push",
) {
  const url = new URL(window.location.href);
  if (projectUuid) url.searchParams.set(PROJECT_QUERY_KEY, projectUuid);
  else url.searchParams.delete(PROJECT_QUERY_KEY);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history[mode === "replace" ? "replaceState" : "pushState"](
    null,
    "",
    next,
  );
}

export interface CanvasUser {
  id: number;
  username: string;
  role: "user" | "admin";
}

interface Props {
  user: CanvasUser;
  onLogout: () => void;
}

export default function App({ user, onLogout }: Props) {
  const [view, setView] = useState<"home" | "canvas" | "studio">("home");
  const [restoring, setRestoring] = useState(
    Boolean(currentProjectIdFromUrl()),
  );
  const [openingProjectName, setOpeningProjectName] = useState<string | null>(
    null,
  );
  const {
    loadProject,
    clearProject,
    syncProject,
    applyRemoteNodeEvent,
    persistNodes,
    persistViewport,
  } = useCanvasStore();
  const projectUuid = useCanvasStore((state) => state.projectUuid);
  const [syncConflict, setSyncConflict] = useState(false);
  // 两种情况的提示完全不同：整份基准过期才真的停了保存，单个节点冲突只是跳过那几个节点。
  // 2026-08-15 用户报"我没开别的页面为什么说保存已暂停"——当时横幅两句话都不成立。
  const [syncSavePaused, setSyncSavePaused] = useState(false);
  const [syncConflictNodeCount, setSyncConflictNodeCount] = useState(0);
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const nodeEventCursorRef = useRef(0);

  const openProject = useCallback(
    async (
      uuid: string,
      historyMode: "push" | "replace" = "push",
      // 只是为了让「正在打开…」那屏显示画布名。以前这里收的是画布管理页预览缓存里那份
      // 完整画布，但下面 `void prefetchedProject` 直接把它丢掉、始终重新 get ——
      // 那个参数从来没省过一次请求，唯一作用就是取里面的名字。预览功能删掉后直接收名字。
      name?: string,
    ) => {
      setOpeningProjectName(name ?? null);
      setRestoring(true);
      try {
        // 拦截脚本会在这个请求前自动完成 enter 并带上会话头
        const project = await projectsApi.get(uuid);
        loadProject(project);
        setSyncConflict(false);
        setView("canvas");
        syncProjectUrl(uuid, historyMode);
      } finally {
        setRestoring(false);
        setOpeningProjectName(null);
      }
    },
    [loadProject],
  );

  const goHome = useCallback((historyMode: "push" | "replace" = "push") => {
    const leavingProject = useCanvasStore.getState().projectUuid;
    if (leavingProject) {
      // 不在这里注销会话：自动保存有 500ms 防抖，此刻可能还有一次保存在途，
      // 提前销毁令牌会让那次保存被拒、节点丢失。拦截脚本只做本地停用，
      // 服务端令牌等下次从管理页进入时原子替换。
      clearProject();
    }
    setView("home");
    setRestoring(false);
    syncProjectUrl(null, historyMode);
  }, [clearProject]);

  useEffect(() => {
    let cancelled = false;
    void accountApi
      .status()
      .then((status) => {
        if (!cancelled) setNeedsApiKey(!status.hasApiKey);
      })
      .catch(() => {
        if (!cancelled) setNeedsApiKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const restoreProject = async () => {
      const projectId = currentProjectIdFromUrl();

      if (!projectId) {
        if (!cancelled) {
          setView("home");
          setRestoring(false);
        }
        return;
      }

      if (!cancelled) setRestoring(true);

      try {
        // 刷新时若这个标签页没有有效会话，拦截脚本会直接接管页面显示阻断提示，
        // 这里不需要再判断一次。
        const project = await projectsApi.get(projectId);
        if (cancelled) return;
        loadProject(project);
        setSyncConflict(false);
        setView("canvas");
      } catch {
        if (cancelled) return;
        clearProject();
        setView("home");
        syncProjectUrl(null, "replace");
      } finally {
        if (!cancelled) setRestoring(false);
      }
    };

    void restoreProject();

    const handlePopState = () => {
      void restoreProject();
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", handlePopState);
    };
  }, [clearProject, loadProject]);

  useEffect(() => {
    if (view !== "canvas" || !projectUuid) return;
    let cancelled = false;
    let syncing = false;
    let queued = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const syncLatest = async (changedNodeKeys: string[] = []) => {
      if (syncing) {
        queued = true;
        return;
      }
      // 本页的保存还没落地就别拉快照：那份快照必然比本地已经写进去的东西旧，套上来会把
      // 节点版本基准按低值重置，紧接着的保存整批 409。等保存排空再同步。
      if (hasPendingNodeSaves(projectUuid)) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (!cancelled) void syncLatest(changedNodeKeys);
        }, SYNC_RETRY_WHILE_SAVING_MS);
        return;
      }
      syncing = true;
      try {
        const latest = await projectsApi.getRealtime(projectUuid);
        if (
          !cancelled &&
          useCanvasStore.getState().projectUuid === projectUuid
        ) {
          const latestContentVersion = String(
            latest.projectMeta?.contentVersion || "",
          );
          if (useCanvasStore.getState().isDirty) {
            setSyncConflict(true);
          } else if (
            latestContentVersion &&
            latestContentVersion === useCanvasStore.getState().contentVersion
          ) {
            // 服务端这份跟本地一模一样（内容版本是整份节点列表的 sha1）。这时候还去
            // syncProject 只会白重建一遍节点树、把保存基准重置一遍，然后 React Flow
            // 重新量一遍尺寸把所有节点标成"变了"，引发一整轮全量重存。
            // SSE 刚连上时服务端会先发一帧 ready，它带着最近所有变更的 nodeKey——包括
            // 本页自己刚写的那些，于是每次打开画布都会白跑这一整轮。
            setSyncConflict(false);
          } else {
            syncProject(latest, changedNodeKeys);
            setSyncConflict(false);
          }
        }
      } catch (error) {
        if (!cancelled) console.error("canvas realtime sync failed", error);
      } finally {
        syncing = false;
        if (queued && !cancelled) {
          queued = false;
          void syncLatest();
        }
      }
    };

    // 拦截脚本会给这个 URL 补上 canvasSession 参数（EventSource 不能带自定义头），
    // 并负责在收到失效事件时接管页面。
    const source = new EventSource(
      `/api/projects/${encodeURIComponent(projectUuid)}/events`,
    );
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.nodeEvent?.id) {
          nodeEventCursorRef.current = Math.max(nodeEventCursorRef.current, Number(payload.nodeEvent.id));
          if (String(payload.clientId || "") !== CANVAS_CLIENT_ID) {
            applyRemoteNodeEvent(payload.nodeEvent);
          }
          return;
        }
        if (String(payload.canvasId || "") !== projectUuid) return;
        if (String(payload.clientId || "") === CANVAS_CLIENT_ID) return;
        const currentVersion = useCanvasStore.getState().contentVersion;
        if (
          payload.contentVersion &&
          String(payload.contentVersion) === currentVersion
        )
          return;
        void syncLatest(
          payload.fullSnapshot
            ? []
            : Array.isArray(payload.changedNodeKeys)
              ? payload.changedNodeKeys
              : [],
        );
      } catch {
        // Ignore malformed heartbeat/event frames.
      }
    };

    const onConflict = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (String(detail.projectUuid || "") !== projectUuid) return;
      setSyncConflict(true);
      // savePaused 缺省按"暂停"处理：老的事件源没带这个字段，宁可提示得重一点
      setSyncSavePaused(detail.savePaused !== false);
      setSyncConflictNodeCount(
        Array.isArray(detail.changedNodeKeys) ? detail.changedNodeKeys.length : 0,
      );
    };
    window.addEventListener(CANVAS_REMOTE_SYNC_REQUIRED_EVENT, onConflict);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      source.close();
      window.removeEventListener(CANVAS_REMOTE_SYNC_REQUIRED_EVENT, onConflict);
    };
  }, [applyRemoteNodeEvent, clearProject, projectUuid, syncProject, view]);

  // 会话心跳由拦截脚本按 5 秒一次维持，这里不要再发一份。

  useEffect(() => {
    if (view !== "canvas") return;
    const flushViewport = () => {
      void persistViewport();
    };
    window.addEventListener("pagehide", flushViewport);
    window.addEventListener("beforeunload", flushViewport);
    return () => {
      window.removeEventListener("pagehide", flushViewport);
      window.removeEventListener("beforeunload", flushViewport);
    };
  }, [persistViewport, view]);

  if (restoring) return <CanvasOpeningScreen name={openingProjectName} />;
  // 会话失效的阻断页由拦截脚本直接接管整页，这里不再实现第二套。

  if (restoring) {
    return (
      <div
        className="flex items-center justify-center"
        style={{
          height: "100vh",
          background: "#000",
          color: "#8a8a8a",
          fontSize: 14,
        }}
      >
        正在打开画布...
      </div>
    );
  }

  if (view === "studio") {
    return <StudioApp onBack={() => setView("home")} />;
  }

  if (view === "home") {
    return (
      <ProjectList
        onOpen={(uuid, name) => openProject(uuid, "push", name)}
        onOpenStudio={() => setView("studio")}
        user={user}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div
      className="shotflow-canvas-screen"
      style={{
        height: "100vh",
        background: "#000",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <TopNav onHome={goHome} user={user} onLogout={onLogout} />
      {needsApiKey ? (
        <ReplaceApiKeyDialog
          dismissible={false}
          onClose={() => {}}
          onSaved={() => setNeedsApiKey(false)}
        />
      ) : null}
      {syncConflict ? (
        <div
          style={{
            position: "absolute",
            top: 58,
            // 资产库停靠栏展开时跟着右移，别被盖住（变量由 CanvasAssetDock 发布）
            left: "calc(16px + var(--sf-asset-dock-width, 0px))",
            right: 16,
            zIndex: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 14px",
            border: "1px solid rgba(255, 183, 77, 0.55)",
            borderRadius: 10,
            background: "rgba(53, 34, 12, 0.94)",
            color: "#ffe8ba",
            fontSize: 13,
          }}
        >
          <span>
            {syncSavePaused
              ? "这个画布的基准版本已过期，为防止覆盖别人的修改，当前页面已暂停保存。请加载最新版本。"
              : `有 ${syncConflictNodeCount || 1} 个节点在服务端已更新，已跳过它们；画布其余修改仍在正常保存。加载最新版本即可对齐这几个节点。`}
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={async () => {
                if (!projectUuid) return;
                const latest = await projectsApi.getRealtime(projectUuid);
                loadProject(latest);
                setSyncConflict(false);
                setSyncSavePaused(false);
                setSyncConflictNodeCount(0);
              }}
              style={{
                border: "1px solid rgba(255,255,255,.28)",
                borderRadius: 7,
                padding: "6px 10px",
                background: "#fff3d6",
                color: "#4b300a",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              加载最新版本
            </button>
            <button
              type="button"
              onClick={() => setSyncConflict(false)}
              title={syncSavePaused
                ? "隐藏提示不会恢复保存；加载最新版本后才会恢复"
                : "只是隐藏提示；保存本来就没有停"}
              style={{
                border: "1px solid rgba(255,255,255,.2)",
                borderRadius: 7,
                padding: "6px 10px",
                background: "transparent",
                color: "#ffe8ba",
                cursor: "pointer",
              }}
            >
              {syncSavePaused ? "隐藏提示（仍暂停保存）" : "隐藏提示"}
            </button>
          </span>
        </div>
      ) : null}
      <div
        className="shotflow-canvas-stage relative overflow-hidden"
        style={{ height: "100%" }}
      >
        <Canvas />
      </div>
    </div>
  );
}

function CanvasOpeningScreen({ name }: { name?: string | null }) {
  return (
    <div
      className="flex items-center justify-center"
      style={{
        height: "100vh",
        background: "#000",
        color: "#e8e4ff",
        fontSize: 14,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(circle at 45% 38%, rgba(124,92,252,0.18), transparent 34%), radial-gradient(circle, rgba(172,205,255,0.16) 1px, transparent 1px)",
          backgroundSize: "auto, 22px 22px",
          opacity: 0.72,
        }}
      />
      <div
        style={{
          position: "relative",
          minWidth: 280,
          padding: "22px 24px",
          borderRadius: 16,
          border: "1px solid rgba(183,167,255,0.22)",
          background: "rgba(14, 12, 23, 0.72)",
          boxShadow:
            "0 28px 90px rgba(0,0,0,0.48), 0 0 46px rgba(124,92,252,0.18)",
          backdropFilter: "blur(18px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 12,
              border: "1px solid rgba(201,190,255,0.34)",
              display: "grid",
              placeItems: "center",
              background:
                "linear-gradient(135deg, rgba(124,92,252,0.28), rgba(80,190,255,0.12))",
            }}
          >
            <div
              style={{
                width: 15,
                height: 15,
                borderRadius: "50%",
                border: "2px solid rgba(255,255,255,0.28)",
                borderTopColor: "#ffffff",
                animation: "spin 0.9s linear infinite",
              }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0 }}>
              正在打开画布
            </div>
            <div
              style={{
                marginTop: 4,
                color: "#938aac",
                fontSize: 12,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 360,
              }}
            >
              {name || "正在读取节点、连线和素材预览..."}
            </div>
          </div>
        </div>
        <div
          style={{
            height: 3,
            marginTop: 18,
            overflow: "hidden",
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              width: "42%",
              height: "100%",
              borderRadius: 999,
              background:
                "linear-gradient(90deg, transparent, #b9a7ff, transparent)",
              animation: "shotflow-loading-bar 1.15s ease-in-out infinite",
            }}
          />
        </div>
      </div>
    </div>
  );
}
