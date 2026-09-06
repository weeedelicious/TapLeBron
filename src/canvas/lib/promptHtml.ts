/**
 * 提示词编辑器的 HTML 清洗。
 *
 * 背景：PromptEditor 是个 contenteditable，此前既没有 onPaste 处理、注入 htmlSnapshot 时也
 * 不清洗。于是从 Word / 网页 / AI 对话里粘贴富文本时，浏览器把原始 HTML 连同内联样式一起插
 * 进编辑器，并被原样存进 params.promptHtml。
 *
 * 2026-08-18 线上实测（最近 40 个画布、1597 个节点、299 个有 promptHtml）：
 *   固定 width:NNpx  157 个 · white-space:nowrap  97 个 · white-space:pre  12 个
 *   MsoNormal(Word 指纹)  7 个
 * 内联样式压过编辑器容器的 pre-wrap / break-word，于是带 nowrap 的段落死不换行，被外层的
 * overflowX: hidden 裁掉 —— 用户看到的「有些字会换行有些不会」就是这个。
 * 附带损害：有几个节点的 promptHtml 到了 13~15 万字符（正文才两三千字），全是标签垃圾，
 * 这些都会进画布保存和 canvas_revisions。
 *
 * 硬约束：**chip（@引用素材）是我们自己生成的，一个字节都不许动。**
 * chip 靠外层 span 上的 data-chip="1" 识别，它内部那个名字 span 本来就要 white-space:nowrap
 * （名字要省略号截断，不能换行）。所以遇到 chip 整棵子树直接跳过。
 */

/** chip 的识别标记，与 PromptEditor 的 buildChipHtml 保持一致。 */
const CHIP_SELECTOR = '[data-chip="1"]';

/** 这些内联样式属性会破坏换行或布局，从非 chip 元素上一律剥掉。 */
const BLOCKED_STYLE_PROPS = [
  'white-space',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'font',
  'font-family',
  'font-size',
  'line-height',
  'word-break',
  'overflow-wrap',
  'overflow',
  'position',
  'float',
  'display',
];

/** 这些属性是老式 HTML 的排版残留，同样会影响布局。 */
const BLOCKED_ATTRS = ['width', 'height', 'align', 'bgcolor', 'valign', 'nowrap', 'size', 'face'];

/**
 * 粘贴垃圾里常见的、渲染不出东西但会被一起存下来的元素。
 *
 * 只能按 nodeName 比对，**绝不能**把这些名字当 CSS 选择器交给 querySelectorAll：
 * Word 的 <o:p> 标签名带冒号，'o:p' 按 CSS 语法是「元素 o + 伪类 :p」，而 :p 不是合法伪类，
 * Chrome 会直接抛 SyntaxError。2026-08-18 00:19 上线的那版就是这么写的，结果只要
 * promptHtml 里有任何标签就抛异常、整个画布黑屏（这句是无条件执行的，跟内容无关）。
 * 更阴的是 jsdom 的 nwsapi 对 'o:p' 宽容、返回空集合，所以 199 条单测全绿也没拦住。
 */
const DROP_TAGS = new Set(['STYLE', 'META', 'LINK', 'TITLE', 'SCRIPT', 'XML', 'O:P']);

function stripBlockedStyles(element: Element) {
  const style = element.getAttribute('style');
  if (!style) return;
  const kept = style
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const prop = declaration.split(':')[0]?.trim().toLowerCase();
      if (!prop) return false;
      // -webkit-/-moz- 前缀的同名属性一样要剥
      const bare = prop.replace(/^-[a-z]+-/, '');
      return !BLOCKED_STYLE_PROPS.includes(bare);
    });
  if (kept.length) element.setAttribute('style', kept.join('; '));
  else element.removeAttribute('style');
}

/**
 * 清洗一份 promptHtml：剥掉会破坏换行的外来内联样式与排版属性，chip 子树整棵保留。
 * 只改属性、不动 DOM 结构（除了删掉 style/meta 这类不渲染的元素），所以不会打乱正文顺序。
 *
 * 传进来不是 HTML（没有标签）时原样返回 —— 纯文本没什么可洗的。
 */
export function sanitizePromptHtml(html: string): string {
  const raw = String(html ?? '');
  if (!raw) return '';
  if (typeof document === 'undefined') return raw;
  if (!/[<]/.test(raw)) return raw;

  // 这个函数跑在 PromptEditor 的挂载路径上：抛出去就是整个画布白/黑屏。
  // 清洗只是"让换行正常"的优化，不是正确性前提 —— 万一再出意外，退回未清洗的原文，
  // 用户最多看到几段不换行，而不是打不开节点。2026-08-18 的黑屏教训。
  try {
    const container = document.createElement('div');
    container.innerHTML = raw;

    // 先删掉不渲染的元素。按 nodeName 比对，不要构造 querySelectorAll(标签名) —— 见 DROP_TAGS。
    for (const element of Array.from(container.querySelectorAll('*'))) {
      if (DROP_TAGS.has(element.nodeName.toUpperCase())) element.remove();
    }

    for (const element of Array.from(container.querySelectorAll('*'))) {
      // chip 本身和 chip 内部的一切都不动
      if (element.closest(CHIP_SELECTOR)) continue;
      stripBlockedStyles(element);
      for (const attr of BLOCKED_ATTRS) element.removeAttribute(attr);
    }

    return container.innerHTML;
  } catch (error) {
    console.error('[promptHtml] 清洗失败，按原文渲染', error);
    return raw;
  }
}

/**
 * 粘贴时用：把剪贴板内容压成纯文本，只保留换行。
 * 编辑器容器是 white-space: pre-wrap，所以 \n 会照常显示成换行，不需要转成 <br>。
 */
export function plainTextFromClipboard(data: DataTransfer | null): string {
  if (!data) return '';
  const text = data.getData('text/plain');
  if (text) return normalizeClipboardText(text);
  // 只有 HTML 没有纯文本的情况（少见，某些应用只给 text/html）：取其文本内容
  const html = data.getData('text/html');
  if (!html || typeof document === 'undefined') return '';
  // 同样兜住：粘贴失败顶多这一次粘不进去，不能把编辑器整个带崩。
  try {
    const container = document.createElement('div');
    container.innerHTML = html;
    // 块级元素之间要补换行，否则整段会被挤成一行
    container.querySelectorAll('p, div, li, br, h1, h2, h3, tr').forEach((element) => {
      element.insertAdjacentText('afterend', '\n');
    });
    return normalizeClipboardText(container.textContent || '');
  } catch (error) {
    console.error('[promptHtml] 解析剪贴板 HTML 失败', error);
    return '';
  }
}

/**
 * 剪贴板里常带的不可见字符：零宽（200B-200D）、方向标记（200E/200F）、
 * bidi 嵌入与隔离控制（202A-202E、2066-2069）、BOM（FEFF）。
 * 用转义写法而不是把字符本身放进源码 —— 隐形字符在代码里没法肉眼校对。
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/** 不换行空格（A0）和窄不换行空格（202F）统一成普通空格。 */
const NBSP_CHARS = /[\u00A0\u202F]/g;

/** 统一行尾、去掉不可见的方向控制字符，并把行尾空白收干净。 */
export function normalizeClipboardText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // Word / 网页复制常带的零宽和方向标记，留着会让后面的字数统计和模型输入都变脏
    .replace(INVISIBLE_CHARS, '')
    .replace(NBSP_CHARS, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    // 三个以上连续空行压成两个
    .replace(/\n{3,}/g, '\n\n');
}
