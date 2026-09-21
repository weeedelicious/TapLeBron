/**
 * 独占画布会话脚本的回归测试。
 *
 * 测的是线上正在跑的那个文件本身（public/canvas-exclusive-session-*.js），不是它的副本，
 * 也不改它一个字：文件名从发布入口 index.html 里解析，读出来在 jsdom 里执行。
 *
 * 每一条都对应一次真实事故：
 *   - 令牌注入漏了某条网络路径 → "打开 B 之后 A 读不了、B 也进不去"
 *   - 返回管理页把令牌删了      → 回到管理页再进画布被自己顶掉，打不开
 *   - 管理页请求没走预览裁剪    → 画布管理页列表被独占会话拦住
 *
 * 测不到的（必须人工开两个浏览器验）：脚本相对主 bundle 的真实执行时序、
 * classic script 与 module 的调度差异、多标签页竞争。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const RELEASE_INDEX = "public/releases/matting-rectangle-live-preview-20260811/index.html";
const SESSION_HEADER = "x-shotflow-canvas-session";
const PREVIEW_HEADER = "x-shotflow-canvas-preview";
const PROJECT = "220";
const TOKEN = "test-token-abc";
const STORAGE_KEY = `shotflow.canvas-session.v1:${PROJECT}`;

function liveSessionScript() {
  const html = readFileSync(path.join(ROOT, RELEASE_INDEX), "utf8");
  const match = html.match(/src="\/(canvas-exclusive-session[^"?]*\.js)/);
  if (!match) throw new Error("发布入口没有引用独占会话脚本");
  return {
    name: match[1],
    source: readFileSync(path.join(ROOT, "public", match[1]), "utf8"),
  };
}

type FetchCall = { url: string; headers: Record<string, string> };

let fetchCalls: FetchCall[] = [];
let eventSourceUrls: string[] = [];
let xhrHeaders: Record<string, string> = {};
/** XHR 实际调用 send() 的次数。补丁里一旦"短路不发"，axios 的 promise 就永不结束，
 *  页面会永久卡在"正在打开画布"——2026-08-14 因此挂过一次，所以这个必须被断言。 */
let xhrSends = 0;
/** 让单个用例决定底层（nativeFetch）怎么回，从而走脚本自己的补丁逻辑。
 *  返回 Promise 就能把某条请求按住不放，用来复现"enter 还在飞"的那个窗口。 */
let responder: ((url: string) => Response | Promise<Response> | null) | null = null;
const originals = {
  fetch: window.fetch,
  xhr: window.XMLHttpRequest,
  eventSource: (window as unknown as { EventSource?: unknown }).EventSource,
  pushState: window.history.pushState,
  setTimeout: window.setTimeout,
  setInterval: window.setInterval,
};
/** 脚本一装上就会起 5 秒心跳。每个用例都装一遍脚本，旧实例的心跳如果留着，
 *  会在后面的用例里拿着当前 responder 的响应去 revoke，测试变成偶发失败。
 *  这里记下每个实例起的定时器，用例结束一并清掉。 */
let timers: number[] = [];

/** 装脚本需要但 jsdom 没有的东西，并记录所有出站请求。 */
function installHarness() {
  fetchCalls = [];
  eventSourceUrls = [];
  xhrHeaders = {};
  xhrSends = 0;
  timers = [];

  // 必须包"装载这一刻"的实现，不能包模块加载时捕获的那个：用例先调 vi.useFakeTimers()
  // 时，当前的 setTimeout 已经是假时钟，转发给模块级的真实实现会让 advanceTimersByTime
  // 永远推不动脚本里的定时器（2026-08-14 保存告警的测试就这样假红过一次）。
  const baseSetTimeout = typeof window.setTimeout === 'function' ? window.setTimeout : originals.setTimeout;
  const baseSetInterval = typeof window.setInterval === 'function' ? window.setInterval : originals.setInterval;
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    const id = baseSetTimeout.call(window, handler, timeout, ...rest);
    timers.push(id as unknown as number);
    return id;
  }) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    const id = baseSetInterval.call(window, handler, timeout, ...rest);
    timers.push(id as unknown as number);
    return id;
  }) as typeof window.setInterval;

  window.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : String((input as Request)?.url ?? "");
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    fetchCalls.push({ url, headers });
    const custom = responder?.(url);
    if (custom) return custom;
    // enter 请求要回一个可用令牌，否则脚本会走 revoke 分支
    if (url.includes("/access-session/enter")) {
      return new Response(JSON.stringify({ token: TOKEN }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof window.fetch;

  // jsdom 没有 EventSource；脚本在顶层 `extends` 它，缺了会直接抛错。
  class FakeEventSource {
    url: string;
    constructor(url: string) {
      this.url = url;
      eventSourceUrls.push(url);
    }
    addEventListener() {}
    close() {}
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

  class FakeXHR {
    method = "";
    url = "";
    responseText = "{}";
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      const normalized = name.toLowerCase();
      // Match browsers: setting the same XHR request header twice appends the
      // second value instead of replacing the first one.
      xhrHeaders[normalized] = xhrHeaders[normalized]
        ? `${xhrHeaders[normalized]}, ${value}`
        : value;
    }
    addEventListener() {}
    send() {
      xhrSends += 1;
    }
  }
  window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
}

function loadScript(locationSearch: string, seededToken?: string) {
  window.history.replaceState(null, "", `/canvas${locationSearch}`);
  window.sessionStorage.clear();
  if (seededToken) window.sessionStorage.setItem(STORAGE_KEY, seededToken);
  installHarness();
  // 脚本是 IIFE，没有导出；在当前 jsdom 全局上执行它，让它自己去 patch 全局。
  new Function(liveSessionScript().source)();
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  responder = null;
  for (const id of timers) {
    clearTimeout(id);
    clearInterval(id);
  }
  timers = [];
  // 先让 vitest 还原它自己捕获的实现，再放回我们的原件：反过来的话假时钟会把
  // 我们的包装函数当成"原件"存下来，下一个用例装载时拿到的就是层层嵌套甚至 undefined。
  vi.useRealTimers();
  window.setTimeout = originals.setTimeout;
  window.setInterval = originals.setInterval;
  window.fetch = originals.fetch;
  window.XMLHttpRequest = originals.xhr;
  (window as unknown as { EventSource?: unknown }).EventSource = originals.eventSource;
  window.history.pushState = originals.pushState;
  window.sessionStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("独占会话脚本：文件本身", () => {
  it("发布入口引用的脚本存在且可执行", () => {
    const { name, source } = liveSessionScript();
    expect(name).toMatch(/^canvas-exclusive-session/);
    expect(source).toContain("X-Shotflow-Canvas-Session");
    expect(() => loadScript(`?project=${PROJECT}`, TOKEN)).not.toThrow();
  });
});

describe("令牌必须注入到全部三条网络路径", () => {
  it("fetch 带上会话头", async () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    await window.fetch(`/api/projects/${PROJECT}/nodes/upsert`, { method: "POST", body: "{}" });
    const call = fetchCalls.find((entry) => entry.url.includes("/nodes/upsert"));
    expect(call?.headers[SESSION_HEADER]).toBe(TOKEN);
  });

  it("XMLHttpRequest 带上会话头", () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    const xhr = new window.XMLHttpRequest();
    xhr.open("POST", `/api/projects/${PROJECT}/nodes/upsert`);
    xhr.send("{}");
    expect(xhrHeaders[SESSION_HEADER]).toBe(TOKEN);
  });

  it("does not duplicate a session header already supplied by an upload request", () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    const xhr = new window.XMLHttpRequest();
    xhr.open("POST", "/api/assets/upload");
    xhr.setRequestHeader("X-Shotflow-Canvas-Session", TOKEN);
    const body = new FormData();
    body.set("projectUuid", PROJECT);
    xhr.send(body);

    expect(xhrHeaders[SESSION_HEADER]).toBe(TOKEN);
    expect(xhrSends).toBe(1);
  });

  it("视频元数据请求带上会话头", async () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    const xhr = new window.XMLHttpRequest();
    xhr.open(
      "GET",
      `/api/media/metadata?projectUuid=${PROJECT}&url=${encodeURIComponent(`/assets/${PROJECT}/video.mp4`)}`,
    );
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(xhrHeaders[SESSION_HEADER]).toBe(TOKEN);
    expect(xhrSends).toBe(1);
  });

  it("EventSource 把令牌放进 URL", () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    new (window as unknown as { EventSource: new (url: string) => unknown }).EventSource(
      `/api/projects/${PROJECT}/events`,
    );
    expect(eventSourceUrls[0]).toContain(`canvasSession=${TOKEN}`);
  });
});

describe("返回画布管理页不能注销令牌", () => {
  it("pushState 回到无 project 的地址后，令牌仍在 sessionStorage 里", () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    window.history.pushState(null, "", "/canvas");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
  });
});

describe("画布管理页的请求走预览裁剪", () => {
  // 管理页读画布详情时会带 ?preview=1（见 lib/api.ts 的 projectsApi.get）。
  // 少了这条，管理页列表会去抢独占会话，把用户正在编辑的画布顶掉。
  it("preview 请求带 preview 头，且不去抢会话", async () => {
    loadScript("");
    await window.fetch(`/api/projects/${PROJECT}?preview=1`);
    const call = fetchCalls.find((entry) => entry.url.includes("preview=1"));
    expect(call?.headers[PREVIEW_HEADER]).toBe("1");
    expect(fetchCalls.some((entry) => entry.url.includes("/access-session/enter"))).toBe(false);
  });
});

describe("enter 必须串行，不能并发抢会话", () => {
  it("同一画布的并发读只触发一次 enter", async () => {
    loadScript("");
    await Promise.all([
      window.fetch(`/api/projects/${PROJECT}`),
      window.fetch(`/api/projects/${PROJECT}`),
      window.fetch(`/api/projects/${PROJECT}`),
    ]);
    const enters = fetchCalls.filter((entry) => entry.url.includes("/access-session/enter"));
    expect(enters).toHaveLength(1);
  });

  // 2026-08-14 事故：B 页面正常进入后会突然显示"该画布已在另一个页面打开"。
  // 原因不是通讯延时，是 A 被踢之后 revoke() 清掉了自己的令牌，而 XHR 那条补丁
  // 没有 blocked 守卫（axios 走的正是 XHR），于是失效页的下一个读请求又去 enter，
  // 把 B 顶掉；B 同样处理，两页来回互抢。
  it("失效页的 XHR 读请求不许再 enter，但必须照常发出去（否则 promise 永不结束）", async () => {
    loadScript(`?project=${PROJECT}`, TOKEN);

    // 模拟被别的页面顶掉：服务端回 REVOKED，脚本会 revoke + 清令牌 + 显示阻断页
    responder = () => new Response(
      JSON.stringify({ errorCode: "CANVAS_ACCESS_SESSION_REVOKED" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
    await window.fetch(`/api/projects/${PROJECT}/nodes/upsert`, { method: "POST", body: "{}" });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    responder = null;
    fetchCalls = [];
    xhrSends = 0;

    // 失效页接着发一个读请求（应用里的实时同步走的正是 axios → XHR 这条路）
    const xhr = new window.XMLHttpRequest();
    xhr.open("GET", `/api/projects/${PROJECT}`);
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchCalls.some((entry) => entry.url.includes("/access-session/enter"))).toBe(false);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(xhrHeaders[SESSION_HEADER]).toBeUndefined();
    // 关键：请求必须真的发出去。短路不发 → 没有 load/error → axios promise 永不结束
    // → 页面永久卡在"正在打开画布"。
    expect(xhrSends).toBe(1);
  });

  it("带 ?project= 但本地没有令牌的页面是失效页，不许自己 enter", async () => {
    loadScript(`?project=${PROJECT}`);
    await window.fetch(`/api/projects/${PROJECT}/nodes/upsert`, { method: "POST", body: "{}" });
    expect(fetchCalls.some((entry) => entry.url.includes("/access-session/enter"))).toBe(false);
    expect(fetchCalls.some((entry) => entry.url.includes("/nodes/upsert"))).toBe(false);
  });

  it("template editor explicitly claims a fresh linked-canvas session", async () => {
    loadScript(`?project=${PROJECT}&claimCanvasSession=1`, "stale-token");

    await vi.waitFor(() => {
      expect(fetchCalls.filter((entry) => entry.url.includes("/access-session/enter"))).toHaveLength(1);
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    });

    expect(new URL(window.location.href).searchParams.get("claimCanvasSession")).toBeNull();
    expect(document.getElementById("shotflow-canvas-blocked")).toBeNull();
  });
});

/**
 * 2026-08-14 的"点进画布闪一下变黑"：
 * pushState 先让 React 挂载画布，画布立刻发出 tasks/active / history-assets /
 * tasks/recoverable / events 这一批请求，而 enter 还在飞（canvas 109 要回传 2.4MB）。
 * 这批请求没有令牌，服务端回 428 CANVAS_ACCESS_SESSION_REQUIRED —— 它当时和
 * CANVAS_ACCESS_SESSION_REVOKED 同在一个集合里，于是被当成"画布被别人接管了"，
 * revoke() 把 enter 刚拿到的好令牌删掉、并把 document.body 整个换成阻断页；
 * 随后 enter 成功触发的 location.reload() 载入一个没有令牌的页面，开局又 showBlocked()。
 * enter 快的画布因为 reload 抢在 428 回来之前，同样的抢跑什么后果都没有——所以
 * 这个 bug 在小画布上完全看不见。
 */
describe("428 只表示这条请求没带令牌，不是被顶掉", () => {
  it("428 REQUIRED 不许清掉令牌，也不许把页面变成阻断页", async () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = () => new Response(
      JSON.stringify({ error: "请从画布管理页面重新进入该画布", errorCode: "CANVAS_ACCESS_SESSION_REQUIRED" }),
      { status: 428, headers: { "Content-Type": "application/json" } },
    );
    const response = await window.fetch(`/api/projects/${PROJECT}/tasks/active`);

    expect(response.status).toBe(428);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    expect(document.getElementById("shotflow-canvas-blocked")).toBeNull();
  });

  it("428 之后页面仍然是活的：下一条请求照样带令牌", async () => {
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = (url) => (url.includes("/tasks/active")
      ? new Response(JSON.stringify({ errorCode: "CANVAS_ACCESS_SESSION_REQUIRED" }), { status: 428, headers: { "Content-Type": "application/json" } })
      : null);
    await window.fetch(`/api/projects/${PROJECT}/tasks/active`);
    responder = null;

    await window.fetch(`/api/projects/${PROJECT}/nodes/upsert`, { method: "POST", body: "{}" });
    const save = fetchCalls.find((entry) => entry.url.includes("/nodes/upsert"));
    expect(save?.headers[SESSION_HEADER]).toBe(TOKEN);
  });

  it("用旧令牌发出去的 409 不许打掉已经换新的会话", async () => {
    loadScript(`?project=${PROJECT}`, "stale-token");
    responder = (url) => (url.includes("/access-session/enter")
      ? null
      : new Response(JSON.stringify({ errorCode: "CANVAS_ACCESS_SESSION_REVOKED" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    // 请求在飞的过程中本页重新拿到了新令牌（管理页再次进入会走到这一步）
    const inflight = window.fetch(`/api/projects/${PROJECT}/tasks/active`);
    window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
    await inflight;

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    expect(document.getElementById("shotflow-canvas-blocked")).toBeNull();
  });
});

describe("enter 还在飞时，抢跑的画布请求必须等令牌", () => {
  it("tasks/active 等到 enter 落地才发，并且带上了令牌", async () => {
    loadScript("");
    let releaseEnter: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      releaseEnter = resolve;
    });
    responder = (url) => (url.includes("/access-session/enter") ? gate : null);

    // 画布路由挂载：读画布详情这条会去 enter，并且被 gate 按住
    const read = window.fetch(`/api/projects/${PROJECT}`);
    await Promise.resolve();
    await Promise.resolve();

    // 同一批挂载请求里的一条（应用里走 axios → XHR）
    const xhr = new window.XMLHttpRequest();
    xhr.open("GET", `/api/projects/${PROJECT}/tasks/active`);
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();

    // 关键：这时候还没令牌，请求绝对不能裸发出去换一个 428 回来
    expect(xhrSends).toBe(0);
    expect(xhrHeaders[SESSION_HEADER]).toBeUndefined();

    releaseEnter(new Response(JSON.stringify({ token: TOKEN }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await read;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(xhrSends).toBe(1);
    expect(xhrHeaders[SESSION_HEADER]).toBe(TOKEN);
  });
});

/**
 * 保存失效告警。
 *
 * 2026-08-14：从共享空间拖节点进画布，刷新后没了。页面是活着的（心跳、视口草稿都在存），
 * 但节点保存请求在一次 409 之后再也没发出过，界面上没有任何提示。
 * canvas 190 的真实形态：18:15:35 保存 200 → 三次 409 → 之后再无 nodes/batch，
 * 而 18:18:13 还在 PATCH /draft，所以人完全看不出保存已经停了。
 *
 * 告警只看结果：保存失败后 20 秒内没有任何一次成功保存，就弹常驻横幅。
 */
describe("保存失效必须让人看得见", () => {
  const WARNING = "#shotflow-save-warning";
  const nodeSave = () => window.fetch(`/api/projects/${PROJECT}/nodes/batch`, { method: "POST", body: "{}" });

  it("保存失败且 20 秒内没有成功 → 弹常驻横幅", async () => {
    vi.useFakeTimers();
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = () => new Response(
      JSON.stringify({ errorCode: "CANVAS_NODE_VERSION_CONFLICT" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
    await nodeSave();

    expect(document.querySelector(WARNING)).toBeNull(); // 还在观察窗口内，先不吵
    await vi.advanceTimersByTimeAsync(20_000);
    expect(document.querySelector(WARNING)).not.toBeNull();
    expect(document.querySelector(WARNING)?.textContent).toContain("没有保存成功");
    expect(document.querySelector("#shotflow-save-warning-reload")).not.toBeNull();
  });

  it("失败后又存成功了 → 不弹（单次冲突后自愈是正常的）", async () => {
    vi.useFakeTimers();
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = () => new Response(JSON.stringify({ errorCode: "CANVAS_NODE_VERSION_CONFLICT" }), { status: 409, headers: { "Content-Type": "application/json" } });
    await nodeSave();
    responder = null;
    await nodeSave();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(document.querySelector(WARNING)).toBeNull();
  });

  it("横幅出现后，一次成功保存就把它撤掉", async () => {
    vi.useFakeTimers();
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = () => new Response(JSON.stringify({ errorCode: "CANVAS_NODE_VERSION_CONFLICT" }), { status: 409, headers: { "Content-Type": "application/json" } });
    await nodeSave();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(document.querySelector(WARNING)).not.toBeNull();

    responder = null;
    await nodeSave();
    expect(document.querySelector(WARNING)).toBeNull();
  });

  it("只看节点保存，视口草稿失败不算（它跟节点保存不是一条路）", async () => {
    vi.useFakeTimers();
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = () => new Response(JSON.stringify({ error: 'x' }), { status: 409, headers: { "Content-Type": "application/json" } });
    await window.fetch(`/api/projects/${PROJECT}/draft`, { method: "PATCH", body: "{}" });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(document.querySelector(WARNING)).toBeNull();
  });

  it("被别的页面顶掉时不叠两层提示：阻断浮层优先", async () => {
    vi.useFakeTimers();
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = () => new Response(
      JSON.stringify({ errorCode: "CANVAS_ACCESS_SESSION_REVOKED" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
    await nodeSave();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(document.querySelector("#shotflow-canvas-blocked")).not.toBeNull();
    expect(document.querySelector(WARNING)).toBeNull();
  });
});

describe("阻断页是浮层，不许拆掉 React 的挂载点", () => {
  // 以前是 document.body.innerHTML = 阻断页，#root 一起没了：一旦判断错，整页
  // 再也救不回来，刷新也没用（sessionStorage 里的令牌已经被 revoke 删掉）。
  it("真被顶掉时盖浮层，#root 原样保留", async () => {
    document.body.innerHTML = '<div id="root">canvas</div>';
    loadScript(`?project=${PROJECT}`, TOKEN);
    responder = () => new Response(
      JSON.stringify({ errorCode: "CANVAS_ACCESS_SESSION_REVOKED" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
    await window.fetch(`/api/projects/${PROJECT}/nodes/upsert`, { method: "POST", body: "{}" });

    expect(document.getElementById("shotflow-canvas-blocked")).not.toBeNull();
    expect(document.getElementById("root")?.textContent).toBe("canvas");
    expect(document.getElementById("shotflow-back-to-management")).not.toBeNull();
  });
});
