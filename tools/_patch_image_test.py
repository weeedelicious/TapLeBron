from pathlib import Path
p = Path(r'C:/Users/wuyixiang/Documents/TapLeBron/tests/empty-video-copy.test.ts')
t = p.read_text(encoding='utf-8')
start = t.find('  it("leaves non-video nodes unchanged"')
print('start', start)
assert start > 0
end = t.find('});', start)
print('end', end)
replacement = '''  it("drops a generated image but keeps prompt and references", () => {
    const data = {
      type: "image",
      name: "image node",
      url: ["/media/out.png"],
      action: "image_generate",
      _primaryAssetUrl: "/media/out.png",
      params: {
        prompt: "night",
        model: "nano-banana",
        imageList: [{ nodeId: "img-1", url: "/media/ref.png", mediaType: "image" }],
        history: [{ id: "h1", url: "/media/old.png" }],
      },
    } as unknown as CanvasNodeData;
    const next = emptyVideoCopyData(data);
    expect(next.url).toEqual([]);
    expect(next._primaryAssetUrl).toBeUndefined();
    expect(next.params).toMatchObject({
      prompt: "night",
      model: "nano-banana",
      imageList: [{ nodeId: "img-1", url: "/media/ref.png", mediaType: "image" }],
    });
    expect((next.params as { history?: unknown }).history).toBeUndefined();
  });

  it("leaves other nodes unchanged", () => {
    const data = { type: "text", name: "note", url: [], action: "text_node" } as CanvasNodeData;
    expect(emptyVideoCopyData(data)).toBe(data);
  });
})'''
t = t[:start] + replacement + '\n'
p.write_text(t, encoding='utf-8')
print('test ok')