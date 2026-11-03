from pathlib import Path
js = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js')
t = js.read_text(encoding='utf-8')
helper = Path('/data/wyx_root/tapflow-workbench/src/canvas/lib/promptDuration.ts').read_text(encoding='utf-8')
helper = helper.replace('export function extractPromptDurationSeconds(sourceText: unknown): number | null', 'function qDuration(sourceText)')
assert helper.startswith('/**') or 'function qDuration' in helper
assert 'function qDuration(sourceText)' in helper
assert 'export function' not in helper
anchor = 'function D7('
assert t.count(anchor)==1
assert 'function qDuration' not in t
t = t.replace(anchor, helper.strip() + '\n' + anchor, 1)
old = 'cr=y.useCallback(()=>{const Oe=Jg(Ee.textList?.filter(_n=>_n.nodeId),st.getState().nodes),Lt=st.getState().nodes.find(_n=>_n.id===t||_n.data.nodeKey===t),en=Lt?wc(Lt.data):Ee;Rt.current?.setPlainText(Oe),i(t,{params:{...en,prompt:Oe,promptChips:[],promptHtml:void 0}})},[t,Ee,i])'
new = 'cr=y.useCallback(()=>{const Oe=Jg(Ee.textList?.filter(_n=>_n.nodeId),st.getState().nodes),Lt=st.getState().nodes.find(_n=>_n.id===t||_n.data.nodeKey===t),en=Lt?wc(Lt.data):Ee,seconds=qDuration(Oe),rule=gz(en.model,en.modeType),locked=rule.min===rule.max&&rule.default===rule.min&&rule.min<0,settings=!locked&&seconds!=null?{...en.settings,duration:D7(en.model,seconds,en.modeType)}:en.settings;Rt.current?.setPlainText(Oe),i(t,{params:{...en,prompt:Oe,promptChips:[],promptHtml:void 0,settings}})},[t,Ee,i])'
print('callback', t.count(old))
assert t.count(old)==1
t = t.replace(old, new, 1)
js.write_text(t, encoding='utf-8')
html = Path('/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html')
h = html.read_text(encoding='utf-8')
oldv = 'index-empty-video-copy.js?v=20261022-empty-image'
newv = 'index-empty-video-copy.js?v=20261022-sync-duration'
print('html', h.count(oldv))
assert h.count(oldv)==1
html.write_text(h.replace(oldv, newv, 1), encoding='utf-8')
print('patched')