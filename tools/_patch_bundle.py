from pathlib import Path
q = chr(34)
src = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-depthcrafter-only.js')
dst = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js')
text = src.read_text(encoding='utf-8')
old_sig = 'duplicateNodes:n=>{e().pushHistory();const{projectUuid:r,nodes:i,edges:s}=e(),o=AI(n,i),a=i.filter(m=>o.has(m.id));if(a.length===0)return;const l=Object.fromEntries(a.map(m=>[m.id,W0()])),d=Date.now(),u=a.map(m=>{const g=l[m.id];return{...m,id:g,position:{x:m.position.x+40,y:m.position.y+40},data:XD(m.data,g,l,d),dragHandle:D0(m.data.type),selected:!1}})'
new_sig = 'duplicateNodes:(n,emptyVideo)=>{e().pushHistory();const{projectUuid:r,nodes:i,edges:s}=e(),o=AI(n,i),a=i.filter(m=>o.has(m.id));if(a.length===0)return;const l=Object.fromEntries(a.map(m=>[m.id,W0()])),d=Date.now(),u=a.map(m=>{const g=l[m.id];const copied=XD(m.data,g,l,d);let data=copied;if(emptyVideo&&copied&&copied.type===' + q + 'video' + q + '){const params={...(copied.params||{})};delete params.history;data={...copied,url:[],params};[' + q + 'poster' + q + ',' + q + 'taskInfo' + q + ',' + q + '_pendingTasks' + q + ',' + q + '_failedGenerations' + q + ',' + q + '_resourceMeta' + q + ',' + q + '_hiddenHistoryUrls' + q + ',' + q + '_assetCreatedAtMs' + q + ',' + q + '_assetGenerationMeta' + q + ',' + q + '_assetPreviewUrls' + q + ',' + q + 'uploadInfo' + q + ',' + q + '_primaryAssetUrl' + q + ',' + q + '_autoGenerate' + q + '].forEach(key=>delete data[key])}return{...m,id:g,position:{x:m.position.x+40,y:m.position.y+40},data,dragHandle:D0(m.data.type),selected:!1}})'
print('sig', text.count(old_sig))
assert text.count(old_sig)==1
text = text.replace(old_sig, new_sig, 1)
old_end = 'r&&ku(r,p,t)},insertFavoritePayload:async(n,r)=>'
new_end = 'r&&ku(r,p,t)},duplicateEmptyVideoNode:n=>{e().duplicateNodes([n],!0)},insertFavoritePayload:async(n,r)=>'
print('end', text.count(old_end))
assert text.count(old_end)==1
text = text.replace(old_end, new_end, 1)
old_btn = 'children:' + q + '创建副本' + q + '}),c.jsx(' + q + 'kbd' + q + ',{children:' + q + '⌘D' + q + '})]}),c.jsxs(' + q + 'button' + q + ',{className:' + q + 'canvas-context-item' + q + ',disabled:!n,onClick:u'
new_btn = 'children:' + q + '创建副本' + q + '}),c.jsx(' + q + 'kbd' + q + ',{children:' + q + '⌘D' + q + '})]}),g?.type===' + q + 'video' + q + '&&c.jsx(' + q + 'button' + q + ',{className:' + q + 'canvas-context-item' + q + ',onClick:()=>{st.getState().duplicateEmptyVideoNode(e.id),m()},children:c.jsx(' + q + 'span' + q + ',{children:' + q + '复制空节点' + q + '})}),c.jsxs(' + q + 'button' + q + ',{className:' + q + 'canvas-context-item' + q + ',disabled:!n,onClick:u'
print('btn', text.count(old_btn))
assert text.count(old_btn)==1
text = text.replace(old_btn, new_btn, 1)
old_pos = 'E=EF(t.screenX,t.screenY,238,420)'
new_pos = 'E=EF(t.screenX,t.screenY,238,g?.type===' + q + 'video' + q + '?456:420)'
print('pos', text.count(old_pos))
assert text.count(old_pos)==1
text = text.replace(old_pos, new_pos, 1)
assert '复制空节点' in text
dst.write_text(text, encoding='utf-8')
html = Path('/data/wyx_root/tapflow-workbench/dist/index.html')
h = html.read_text(encoding='utf-8')
assert 'index-depthcrafter-only.js' in h
html.write_text(h.replace('index-depthcrafter-only.js','index-empty-video-copy.js'), encoding='utf-8')
print('WROTE', dst.stat().st_size)