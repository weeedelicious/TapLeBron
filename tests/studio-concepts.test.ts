import { describe, expect, it } from "vitest";
import {
  normalizeConcepts,
  studioConceptGenerationCost,
  STUDIO_CONCEPT_LIMIT,
  STUDIO_CONCEPT_RATIO_BY_GROUP,
  type StudioConceptItem,
} from "../src/canvas/lib/studio";

let seq = 0;
const makeId = () => `cid-${(seq += 1)}`;

function concept(patch: Partial<StudioConceptItem> = {}): StudioConceptItem {
  return {
    id: makeId(),
    group: "scene",
    name: "场景 · 锻造棚",
    prompt: "设定图：山脚下的锻造棚全景…",
    reason: "1/3/7 镜",
    imageUrl: "",
    nodeKey: "",
    status: "pending",
    error: "",
    ...patch,
  };
}

describe("normalizeConcepts", () => {
  it("收下模型的中文键名", () => {
    const { items } = normalizeConcepts(
      { items: [{ 分组: "lead", 名称: "主角 · 少年铁匠", 提示词: "设定图：少年铁匠全身…", 镜号: "1/2 镜" }] },
      makeId,
    );
    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("lead");
    expect(items[0].name).toBe("主角 · 少年铁匠");
    expect(items[0].prompt).toContain("少年铁匠");
    expect(items[0].reason).toBe("1/2 镜");
  });

  it("认不出来的分组归 scene —— 它的 16:9 最不容易画坏", () => {
    const { items } = normalizeConcepts({ items: [{ group: "怪物", name: "甲", prompt: "乙" }] }, makeId);
    expect(items[0].group).toBe("scene");
  });

  it("status 由有没有图推导，不信任传进来的值", () => {
    const { items } = normalizeConcepts(
      {
        items: [
          // 谎称 ready 但没有图 → pending
          { name: "甲", prompt: "p", status: "ready" },
          // 谎称 pending 但有图 → ready
          { name: "乙", prompt: "p", status: "pending", imageUrl: "/a.png" },
          // 没有图 + failed → 保留 failed 与原因，否则一刷新失败信息就没了
          { name: "丙", prompt: "p", status: "failed", error: "模型超时" },
        ],
      },
      makeId,
    );
    expect(items.map((item) => item.status)).toEqual(["pending", "ready", "failed"]);
    expect(items[2].error).toBe("模型超时");
  });

  it("有图时清掉残留的失败原因", () => {
    const { items } = normalizeConcepts(
      { items: [{ name: "甲", prompt: "p", imageUrl: "/a.png", status: "failed", error: "上次失败了" }] },
      makeId,
    );
    expect(items[0].status).toBe("ready");
    expect(items[0].error).toBe("");
  });

  it("名称和提示词都空的条目丢掉（模型有时尾随空对象）", () => {
    const { items } = normalizeConcepts(
      { items: [{ name: "甲", prompt: "p" }, {}, { group: "prop" }] },
      makeId,
    );
    expect(items).toHaveLength(1);
  });

  it("超出上限截掉，并且裸数组也收", () => {
    const many = Array.from({ length: STUDIO_CONCEPT_LIMIT + 6 }, (_, index) => ({
      name: `甲${index}`,
      prompt: "p",
    }));
    expect(normalizeConcepts(many, makeId).items).toHaveLength(STUDIO_CONCEPT_LIMIT);
  });

  it("已有 id 保留（表格上的勾选和编辑靠它对位）", () => {
    const { items } = normalizeConcepts({ items: [{ id: "keep-me", name: "甲", prompt: "p" }] }, makeId);
    expect(items[0].id).toBe("keep-me");
  });

  it("整个结构乱了也不抛，给空清单", () => {
    expect(normalizeConcepts(null, makeId).items).toEqual([]);
    expect(normalizeConcepts("不是对象", makeId).items).toEqual([]);
    expect(normalizeConcepts({ 概念图: [{ name: "甲" }] }, makeId).items).toEqual([]);
  });
});

describe("studioConceptGenerationCost", () => {
  it("只算勾中的", () => {
    const a = concept();
    const b = concept();
    expect(studioConceptGenerationCost([a, b], new Set([a.id]), false)).toBe(1);
    expect(studioConceptGenerationCost([a, b], new Set(), false)).toBe(0);
  });

  it("默认跳过已经有图的 —— 不勾「重画」就不该重复花钱", () => {
    const drawn = concept({ imageUrl: "/a.png", status: "ready" });
    const todo = concept();
    const picked = new Set([drawn.id, todo.id]);
    expect(studioConceptGenerationCost([drawn, todo], picked, false)).toBe(1);
    expect(studioConceptGenerationCost([drawn, todo], picked, true)).toBe(2);
  });

  it("没有提示词的不算 —— 服务端也画不了它", () => {
    const empty = concept({ prompt: "" });
    expect(studioConceptGenerationCost([empty], new Set([empty.id]), true)).toBe(0);
  });

  it("失败过但没有图的条目照常计入（重试不需要勾重画）", () => {
    const failed = concept({ status: "failed", error: "超时" });
    expect(studioConceptGenerationCost([failed], new Set([failed.id]), false)).toBe(1);
  });
});

describe("概念图比例", () => {
  it("四个分组都有比例，且都在两个生图模型的原生比例里", () => {
    // generateOpenAiImages 对非原生比例直接抛错，所以这张表只能用 image-model-rules.json
    // 里 nativeRatios 覆盖到的值。改这里之前先去那份 json 确认。
    const native = new Set(["1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "4:5", "5:4", "21:9", "2:1"]);
    for (const group of ["lead", "support", "scene", "prop"]) {
      const ratio = STUDIO_CONCEPT_RATIO_BY_GROUP[group];
      expect(ratio, `${group} 缺比例`).toBeTruthy();
      expect(native.has(ratio), `${group} 的 ${ratio} 不是原生比例`).toBe(true);
    }
  });
});
