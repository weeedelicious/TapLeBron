'use strict';

/**
 * 提示词排版（promptHtml）瘦身（2026-11-16）。
 *
 * 7–9 月有人把网页（AI 对话页）上的文字带着原页面排版拖 / 粘进提示词框，promptHtml 里留下了
 * 几百个 style / class / data-* 属性：正文 6000 字，排版 86 万字；每生成一次「生成历史」再存一份，
 * 一个节点 20 条历史就是 8MB，十几块画布因此 8–17MB。
 *
 * 这里只去掉**图片药丸（data-chip="1"）以外**元素上的 style / class / data-* 属性，标签和文字不动，
 * 药丸整段原样保留。清完必须同时满足两条，否则返回原文：
 *   ① 去掉所有标签后的文字与原来逐字一致；
 *   ② 每个药丸的完整 HTML 片段与原来逐字节一致。
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const DROP_ATTR_RE = /\s+(?:style|class|data-(?!chip(?:-preview)?=)[a-zA-Z0-9_-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function textOf(html) {
  return String(html || '').replace(/<[^>]*>/g, '');
}

/** 把每个 data-chip="1" 元素的完整片段按顺序取出来（用于校验药丸没被改动） */
function chipFragments(html) {
  const fragments = [];
  const source = String(html || '');
  TAG_RE.lastIndex = 0;
  let match;
  let chipStart = -1;
  let depth = 0;
  while ((match = TAG_RE.exec(source))) {
    const [whole, closing, rawName, attrs] = match;
    const name = rawName.toLowerCase();
    const selfClosing = VOID_TAGS.has(name) || /\/\s*$/.test(attrs);
    if (chipStart < 0) {
      if (!closing && /\sdata-chip\s*=\s*["']1["']/.test(attrs)) {
        if (selfClosing) { fragments.push(whole); continue; }
        chipStart = match.index;
        depth = 1;
      }
      continue;
    }
    if (selfClosing) continue;
    depth += closing ? -1 : 1;
    if (depth === 0) {
      fragments.push(source.slice(chipStart, match.index + whole.length));
      chipStart = -1;
    }
  }
  return fragments;
}

function stripForeignAttributes(html) {
  const source = String(html || '');
  let out = '';
  let last = 0;
  let chipDepth = 0;
  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(source))) {
    const [whole, closing, rawName, attrs] = match;
    const name = rawName.toLowerCase();
    const selfClosing = VOID_TAGS.has(name) || /\/\s*$/.test(attrs);
    out += source.slice(last, match.index);
    last = match.index + whole.length;
    if (chipDepth > 0) {
      out += whole;
      if (!selfClosing) chipDepth += closing ? -1 : 1;
      continue;
    }
    if (!closing && /\sdata-chip\s*=\s*["']1["']/.test(attrs)) {
      out += whole;
      if (!selfClosing) chipDepth = 1;
      continue;
    }
    out += closing ? whole : `<${rawName}${attrs.replace(DROP_ATTR_RE, '')}>`;
  }
  return out + source.slice(last);
}

/**
 * 返回 { html, changed, savedBytes }。校验不过就原样返回（changed=false）。
 */
function cleanPromptHtml(html) {
  const source = typeof html === 'string' ? html : '';
  if (!source) return { html, changed: false, savedBytes: 0 };
  const cleaned = stripForeignAttributes(source);
  if (cleaned === source) return { html, changed: false, savedBytes: 0 };
  if (textOf(cleaned) !== textOf(source)) return { html, changed: false, savedBytes: 0, rejected: 'text' };
  const before = chipFragments(source);
  const after = chipFragments(cleaned);
  if (before.length !== after.length || before.some((fragment, index) => fragment !== after[index])) {
    return { html, changed: false, savedBytes: 0, rejected: 'chip' };
  }
  return { html: cleaned, changed: true, savedBytes: source.length - cleaned.length };
}

module.exports = { cleanPromptHtml, chipFragments, stripForeignAttributes };
