import { describe, expect, it } from "vitest";
import {
  ASSET_LABEL_OPTIONS,
  ASSET_PROJECT_OPTIONS,
  readAssetLabel,
  readAssetProject,
  visibleAssetTags,
  withAssetLabel,
  withAssetProject,
} from "../src/canvas/lib/libraryTaxonomy";

describe("资产库标签 / 项目（存在 tags 数组里）", () => {
  it("没设置过时读出空串", () => {
    expect(readAssetLabel(undefined)).toBe("");
    expect(readAssetLabel([])).toBe("");
    expect(readAssetProject(["shared"])).toBe("");
  });

  it("读得出写进去的值", () => {
    const tags = withAssetProject(withAssetLabel([], "角色"), "火炬");
    expect(readAssetLabel(tags)).toBe("角色");
    expect(readAssetProject(tags)).toBe("火炬");
  });

  it("改标签不动项目，改项目不动标签", () => {
    let tags = withAssetProject(withAssetLabel([], "角色"), "火炬");
    tags = withAssetLabel(tags, "场景");
    expect(readAssetLabel(tags)).toBe("场景");
    expect(readAssetProject(tags)).toBe("火炬");
    tags = withAssetProject(tags, "RO");
    expect(readAssetLabel(tags)).toBe("场景");
    expect(readAssetProject(tags)).toBe("RO");
  });

  it("同一个前缀不会累积出两条", () => {
    let tags = withAssetLabel([], "角色");
    tags = withAssetLabel(tags, "场景");
    tags = withAssetLabel(tags, "角色");
    expect(tags.filter((tag) => tag.startsWith("label:"))).toHaveLength(1);
  });

  it("设成空串等于清掉", () => {
    let tags = withAssetProject(withAssetLabel(["shared"], "角色"), "小镇");
    tags = withAssetLabel(tags, "");
    tags = withAssetProject(tags, "");
    expect(readAssetLabel(tags)).toBe("");
    expect(readAssetProject(tags)).toBe("");
    // 共享时写进去的业务标记不能被顺手删掉
    expect(tags).toContain("shared");
  });

  it("不碰 tags 里原有的其它值 —— 'shared' 是共享功能写的，必须留着", () => {
    const tags = withAssetLabel(["shared", "自定义"], "角色");
    expect(tags).toContain("shared");
    expect(tags).toContain("自定义");
  });

  it("卡片上展示的自由标签会藏掉内部标记", () => {
    const tags = withAssetProject(
      withAssetLabel(["shared", "自定义"], "角色"),
      "香肠",
    );
    expect(visibleAssetTags(tags)).toEqual(["自定义"]);
  });

  it("前缀值本身带空格也读得回来", () => {
    expect(readAssetLabel(["label:  场景  "])).toBe("场景");
  });

  it("选项表就是产品口径的那几个", () => {
    expect(ASSET_LABEL_OPTIONS).toEqual(["角色", "场景"]);
    expect(ASSET_PROJECT_OPTIONS).toEqual(["火炬", "小镇", "香肠", "RO"]);
  });
});
