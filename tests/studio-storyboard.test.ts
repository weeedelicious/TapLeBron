import { describe, expect, it } from "vitest";
import {
  isAutoShotLabel,
  normalizeStoryboard,
  renumberShots,
  storyboardDurationDelta,
  storyboardToScriptRows,
  storyboardTotalSeconds,
  STUDIO_MAX_ROWS,
  type StudioStoryboardRow,
} from "../src/canvas/lib/studio";

let seq = 0;
const makeId = () => `id-${(seq += 1)}`;

const row = (patch: Partial<StudioStoryboardRow> = {}): StudioStoryboardRow => ({
  id: makeId(),
  shot: "1",
  content: "坐在电脑前，他开始玩游戏。",
  shotSize: "中景",
  movement: "摇镜",
  seconds: 5,
  ...patch,
});

describe("镜号重排", () => {
  it("加减行之后自动序号跟着接上", () => {
    const rows = [row({ shot: "1" }), row({ shot: "7" }), row({ shot: "3" })];
    expect(renumberShots(rows).map((r) => r.shot)).toEqual(["1", "2", "3"]);
  });

  it("合并镜号（4/5）原样保留，后面的行从它之后接着排", () => {
    const rows = [row({ shot: "1" }), row({ shot: "2" }), row({ shot: "4/5" }), row({ shot: "9" })];
    expect(renumberShots(rows).map((r) => r.shot)).toEqual(["1", "2", "4/5", "6"]);
  });

  it("开头就是合并镜号也不会把它冲掉", () => {
    expect(renumberShots([row({ shot: "2/3" }), row({ shot: "1" })]).map((r) => r.shot))
      .toEqual(["2/3", "4"]);
  });

  it("补零的镜号算自动序号（01 → 1）", () => {
    expect(isAutoShotLabel("01")).toBe(true);
    expect(isAutoShotLabel("4/5")).toBe(false);
    expect(isAutoShotLabel("镜1")).toBe(false);
    expect(renumberShots([row({ shot: "01" }), row({ shot: "02" })]).map((r) => r.shot))
      .toEqual(["1", "2"]);
  });

  it("没变化时返回同一个行对象（省掉无谓的重渲染）", () => {
    const first = row({ shot: "1" });
    const out = renumberShots([first]);
    expect(out[0]).toBe(first);
  });
});

describe("模型输出的规范化", () => {
  it("中文键名照样收（模型经常直接用中文）", () => {
    const parsed = normalizeStoryboard(
      [{ 镜号: "1", 内容: "屏幕上显示 Experience 键。", 景别: "特写", 镜头运动: "固定", 时间: 2 }],
      makeId,
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      shot: "1",
      content: "屏幕上显示 Experience 键。",
      shotSize: "特写",
      movement: "固定",
      seconds: 2,
    });
  });

  it("时间按半秒对齐、并钳进合理范围", () => {
    const parsed = normalizeStoryboard(
      [
        { 内容: "a", 时间: 2.37 },
        { 内容: "b", 时间: -4 },
        { 内容: "c", 时间: 9999 },
        { 内容: "d" },
      ],
      makeId,
    );
    expect(parsed.rows.map((r) => r.seconds)).toEqual([2.5, 3, 120, 3]);
  });

  it("{rows:[...]} 和裸数组都认", () => {
    expect(normalizeStoryboard({ rows: [{ 内容: "a" }] }, makeId).rows).toHaveLength(1);
    expect(normalizeStoryboard([{ 内容: "a" }], makeId).rows).toHaveLength(1);
  });

  it("整行空白的丢掉（模型会尾随空对象）", () => {
    const parsed = normalizeStoryboard([{ 内容: "a" }, {}, { 内容: "   " }], makeId);
    expect(parsed.rows).toHaveLength(1);
  });

  it("规范化之后镜号一定是连续的，模型给错也不怕", () => {
    const parsed = normalizeStoryboard(
      [{ 镜号: "3", 内容: "a" }, { 镜号: "3", 内容: "b" }, { 镜号: "99", 内容: "c" }],
      makeId,
    );
    expect(parsed.rows.map((r) => r.shot)).toEqual(["1", "2", "3"]);
  });

  it("行数超上限截断，不会把服务端撑爆", () => {
    const many = Array.from({ length: STUDIO_MAX_ROWS + 50 }, (_, i) => ({ 内容: `第 ${i} 镜` }));
    expect(normalizeStoryboard(many, makeId).rows).toHaveLength(STUDIO_MAX_ROWS);
  });

  it("不是数组也不炸", () => {
    expect(normalizeStoryboard(null, makeId).rows).toEqual([]);
    expect(normalizeStoryboard("乱七八糟", makeId).rows).toEqual([]);
    expect(normalizeStoryboard({ 分镜: [] }, makeId).rows).toEqual([]);
  });
});

describe("时长合计", () => {
  it("合计与目标偏差", () => {
    const rows = [row({ seconds: 5 }), row({ seconds: 2 }), row({ seconds: 1 })];
    expect(storyboardTotalSeconds(rows)).toBe(8);
    expect(storyboardDurationDelta(rows, 15)).toBe(-7);
    expect(storyboardDurationDelta(rows, 8)).toBe(0);
  });
});

describe("投影成画布里的 script 节点", () => {
  it("镜头运动并进画面描述（script 节点没有这一列）", () => {
    const out = storyboardToScriptRows([row({ content: "他走出校门", movement: "推镜", shotSize: "远景", seconds: 10 })]);
    expect(out[0]).toMatchObject({
      sceneType: "远景",
      action: "他走出校门（镜头运动：推镜）",
      duration: 10,
      dialogue: "",
    });
  });

  it("没有镜头运动时不加括号", () => {
    expect(storyboardToScriptRows([row({ content: "他走出校门", movement: "" })])[0].action)
      .toBe("他走出校门");
  });

  it("行 id 带过去，后续阶段能对上同一镜", () => {
    const source = row({ id: "keep-me" });
    expect(storyboardToScriptRows([source])[0].id).toBe("keep-me");
  });
});
