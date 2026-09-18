/* One cloud row per node: independent revisions avoid overwriting a teammate's branch. */
const IM_KIND='industry-map-v1';
const IM_TYPES={sector:{name:'板块',color:'#8979ca',children:['industry','analyst']},industry:{name:'细分行业',color:'#7593be',children:['industry','stock','analyst']},stock:{name:'个股',color:'#68a18d',children:['model','analyst']},analyst:{name:'券商研究员',color:'#c49c64',children:[]},model:{name:'个股模型',color:'#7b9fbc',children:[]}};
let imRows=[],imAllRows=[],imLastDeleted=null,imLoaded=false,imError='',imLoading=null,imKeyword='',imSector='',imZoom=1,imBusy=false;
const imCollapsed=new Set();
const imX=row=>row.extra||{};
const imEsc=rtEscape;
function imUrl(value) {try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
function imName(row) {const x=imX(row);return x.type==='analyst'?[x.broker,row.title].filter(Boolean).join(' · '):row.title||'未命名';}
function imChildren(id,rows=imRows) {return rows.filter(r=>imX(r).parentId===id);}
function imRefreshActive(){const hidden=new Set(imAllRows.filter(r=>imX(r).deletedAt).map(r=>r.id));for(let i=0;i<imAllRows.length;i++){let changed=false;for(const r of imAllRows)if(hidden.has(imX(r).parentId)&&!hidden.has(r.id)){hidden.add(r.id);changed=true;}if(!changed)break;}imRows=imAllRows.filter(r=>!hidden.has(r.id));}
function imVisibleRows() {
  let rows=imRows;
  if(imSector) {
    const keep=new Set([imSector]);
    for(let i=0;i<rows.length;i++){let added=false;for(const r of rows)if(keep.has(imX(r).parentId)&&!keep.has(r.id)){keep.add(r.id);added=true;}if(!added)break;}
    rows=rows.filter(r=>keep.has(r.id));
  }
  const kw=imKeyword.trim().toLocaleLowerCase();if(!kw)return rows;
  const ids=new Set(),byId=new Map(rows.map(r=>[r.id,r]));
  for(const r of rows)if([imName(r),r.content,imX(r).code,...(imX(r).files||[]).map(f=>f.name)].join(' ').toLocaleLowerCase().includes(kw)) {
    ids.add(r.id);let p=imX(r).parentId;const seen=new Set();
    while(p&&byId.has(p)&&!seen.has(p)){seen.add(p);ids.add(p);p=imX(byId.get(p)).parentId;}
  }
  return rows.filter(r=>ids.has(r.id));
}
async function loadIndustryMap() {
  if(!sb)return;if(imLoading)return imLoading;
  imLoading=(async()=>{
    try {
      const rows=[];
      for(let offset=0;;offset+=500){
        const {data,error}=await sb.from('research_framework').select('*').eq('extra->>kind',IM_KIND).order('created_at',{ascending:true}).order('id',{ascending:true}).range(offset,offset+499);
        if(error)throw error;rows.push(...(data||[]));if(!data||data.length<500)break;
      }
      imAllRows=rows;imRefreshActive();imLoaded=true;imError='';
    }catch(e){imError='地图同步失败，请重试。'+(e.message||e);}
    finally{imLoading=null;if(layoutMode==='industry-map')renderIndustryMap();}
  })();return imLoading;
}
function imCard(row,children) {
  const x=imX(row),type=IM_TYPES[x.type]||IM_TYPES.industry;
  const actions=type.children.filter(t=>!(x.type==='industry'&&t==='analyst')).map(t=>`<button class="im-action" data-add="${t}">＋ ${t==='analyst'?'研究员':t==='stock'?'个股 / 研究员':IM_TYPES[t].name}</button>`).join('');
  const attachments=(x.files||[]).filter(f=>imUrl(f.url)).map(f=>`<a class="im-file" target="_blank" rel="noopener noreferrer" href="${imEsc(imUrl(f.url))}">↗ ${imEsc(f.name)}</a>`).join('');
  return `<article class="im-card" data-id="${imEsc(row.id)}" data-type="${imEsc(x.type)}" style="--im-color:${type.color}">
    <div class="im-kind">${type.name}<button class="im-edit" data-edit aria-label="编辑${imEsc(imName(row))}">编辑</button><button class="im-delete" data-delete aria-label="删除${imEsc(imName(row))}">删除</button></div>
    <div class="im-name">${imEsc(imName(row))}</div>${x.code?`<div class="im-detail">${imEsc(x.code)}</div>`:''}
    ${row.content?`<div class="im-detail">${imEsc(row.content)}</div>`:''}
    ${imUrl(x.link)?`<a class="im-file" target="_blank" rel="noopener noreferrer" href="${imEsc(imUrl(x.link))}">↗ 打开模型链接</a>`:''}${attachments}
    <div class="im-meta">${imEsc(row.author||'')} · 填写于 ${rtTime(row.created_at)}${x.editedAt?`<br>${imEsc(x.editedBy||'')} · 修改于 ${rtTime(x.editedAt)}`:''}</div>
    ${actions?`<div class="im-actions">${actions}</div>`:''}
    ${children?`<button class="im-toggle" data-toggle aria-label="${imCollapsed.has(row.id)?'展开':'收起'}${imEsc(imName(row))}" aria-expanded="${!imCollapsed.has(row.id)}">${imCollapsed.has(row.id)?'+':'−'}</button>`:''}
  </article>`;
}
function imBranch(row,byParent,path=new Set()) {
  if(path.has(row.id))return ''; // Malformed imported data must not cause recursion loops.
  const next=new Set(path);next.add(row.id);
  const children=byParent.get(row.id)||[],open=imKeyword.trim()||!imCollapsed.has(row.id);
  return `<li class="im-branch">${imCard(row,children.length)}${children.length&&open?`<ul class="im-children">${children.map(c=>imBranch(c,byParent,next)).join('')}</ul>`:''}</li>`;
}
function renderIndustryMap() {
  const board=document.getElementById('board'),old=board.querySelector('.im-canvas');
  const hadNodes=!!board.querySelector('.im-card');
  const scroll=old?[old.scrollLeft,old.scrollTop]:[0,0];
  const focus=document.activeElement,focused=board.contains(focus)?focus.id:'',caret=focused==='imSearch'?[focus.selectionStart,focus.selectionEnd]:null;
  const rows=imVisibleRows(),byParent=new Map(),ids=new Set(rows.map(r=>r.id));
  rows.forEach(r=>{const p=imX(r).parentId;if(!byParent.has(p))byParent.set(p,[]);byParent.get(p).push(r);});
  const roots=rows.filter(r=>!imX(r).parentId||!ids.has(imX(r).parentId));
  const sectors=imRows.filter(r=>imX(r).type==='sector');
  board.innerHTML=`<div class="im-head"><div class="im-top"><div><div class="im-eyebrow">RESEARCH ATLAS / 行业研究地图</div><h1>行业研究地图</h1><p class="im-sub">板块 → 细分行业 → 个股与模型 · 把值得关注的券商研究员，留在对应的研究方向下。</p></div><div class="im-tools"><button class="btn" id="imFit">适应画布</button><button class="btn" id="imExpand">展开全部</button><button class="btn" id="imExport" ${!imLoaded||imError?'disabled':''}>↓ 导出 Markdown</button><button class="btn primary" id="imAddRoot" ${!imLoaded||imError?'disabled':''}>＋ 添加板块</button></div></div>
    <div class="im-bar"><input class="search" id="imSearch" aria-label="搜索行业地图" placeholder="搜索行业、个股、券商或研究员…" value="${imEsc(imKeyword)}"><select id="imSector" aria-label="筛选板块"><option value="">全部板块</option>${sectors.map(r=>`<option value="${imEsc(r.id)}" ${imSector===r.id?'selected':''}>${imEsc(r.title)}</option>`).join('')}</select><div class="im-legend">${Object.values(IM_TYPES).map(t=>`<span style="--im-color:${t.color}">${t.name}</span>`).join('')}</div></div></div>
    ${imError?`<div class="im-alert" role="alert">${imEsc(imError)} <button class="im-action" id="imRetry">重新同步</button></div>`:''}
    <div class="im-canvas" tabindex="0" aria-label="横向行业树，可上下左右滚动"><div class="im-tree" style="--im-zoom:${imZoom}"><ul class="im-roots">${roots.map(r=>imBranch(r,byParent)).join('')}</ul></div>
    ${!roots.length?`<div class="im-empty"><div class="im-empty-flow"><span>电子</span>→<span>存储</span>→<span>个股 / 研究员 / 模型</span></div><h2>${!imLoaded?'正在同步行业地图…':imRows.length?'没有找到匹配的内容':'从一个板块，开始搭建研究地图'}</h2><p>${imRows.length?'换个关键词，或切换到全部板块。':'分类可以不断细化；每位研究员、每份模型，都有自己的位置和填写日期。'}</p>${!imRows.length&&imLoaded&&!imError?'<div class="im-tools"><button class="btn primary" id="imEmptyAdd">＋ 添加第一个板块</button><button class="btn" id="imExample">使用电子分类起步</button></div><p class="im-hint">电子分类起步：MLCC、存储、芯片设计、设备。</p>':''}</div>`:''}</div>
    <div class="im-bottom"><span>${imError?'同步异常':imLoaded?'● 团队云端同步':'连接中…'}</span><span>${sectors.length} 个板块 · ${imRows.filter(r=>imX(r).type==='industry').length} 个细分行业 · ${imRows.filter(r=>imX(r).type==='stock').length} 只个股 · ${imRows.filter(r=>imX(r).type==='analyst').length} 条研究员记录</span><span>日期均为北京时间 · 横向滚动查看分支</span><div class="im-zoom"><button id="imZoomOut" aria-label="缩小">−</button><span>${Math.round(imZoom*100)}%</span><button id="imZoomIn" aria-label="放大">＋</button></div></div>`;
  if(imLastDeleted&&imAllRows.some(r=>r.id===imLastDeleted&&imX(r).deletedAt)){const b=document.createElement('button');b.className='btn';b.id='imUndoDelete';b.textContent='撤销上次删除';b.onclick=imUndoDelete;board.querySelector('.im-top .im-tools').prepend(b);}
  board.querySelector('#imAddRoot').onclick=()=>imOpen('sector',null);
  board.querySelector('#imEmptyAdd')?.addEventListener('click',()=>imOpen('sector',null));
  board.querySelector('#imExample')?.addEventListener('click',imSeed);
  board.querySelector('#imRetry')?.addEventListener('click',loadIndustryMap);
  board.querySelector('#imFit').onclick=()=>{const canvas=board.querySelector('.im-canvas'),tree=board.querySelector('.im-tree'),rect=tree.getBoundingClientRect();imZoom=Math.max(.35,Math.min(1,Math.floor(Math.min(canvas.clientWidth/(rect.width/imZoom),canvas.clientHeight/(rect.height/imZoom))*100)/100));renderIndustryMap();const c=board.querySelector('.im-canvas');c.scrollLeft=0;c.scrollTop=0;};
  board.querySelector('#imExpand').onclick=()=>{imCollapsed.clear();renderIndustryMap();};
  board.querySelector('#imExport').onclick=imExport;
  board.querySelector('#imSearch').oninput=e=>{imKeyword=e.target.value;renderIndustryMap();};
  board.querySelector('#imSector').onchange=e=>{imSector=e.target.value;renderIndustryMap();};
  board.querySelector('#imZoomOut').onclick=()=>{imZoom=Math.max(.5,Math.round((imZoom-.1)*10)/10);renderIndustryMap();};
  board.querySelector('#imZoomIn').onclick=()=>{imZoom=Math.min(1.5,Math.round((imZoom+.1)*10)/10);renderIndustryMap();};
  board.querySelectorAll('.im-card').forEach(card=>{
    card.querySelector('[data-edit]').onclick=()=>imOpen(null,null,card.dataset.id);
    card.querySelector('[data-delete]').onclick=()=>imDelete(card.dataset.id);
    card.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>b.dataset.add==='stock'?imOpenCombined(card.dataset.id):imOpen(b.dataset.add,card.dataset.id));
    card.querySelector('[data-toggle]')?.addEventListener('click',()=>{imCollapsed.has(card.dataset.id)?imCollapsed.delete(card.dataset.id):imCollapsed.add(card.dataset.id);renderIndustryMap();});
  });
  const canvas=board.querySelector('.im-canvas');canvas.scrollLeft=scroll[0];canvas.scrollTop=scroll[1];
  if(!hadNodes&&roots.length)imCenterRoot();
  if(focused){const el=document.getElementById(focused);el?.focus({preventScroll:true});if(caret)el?.setSelectionRange(...caret);}
}
function imCenterRoot(){const canvas=document.querySelector('.im-canvas'),card=canvas?.querySelector('.im-roots>.im-branch>.im-card');if(canvas&&card){const c=canvas.getBoundingClientRect(),r=card.getBoundingClientRect();canvas.scrollTop+=r.top-c.top+r.height/2-canvas.clientHeight/2;canvas.scrollLeft=0;}}
let imResizeTimer;
window.addEventListener('resize',()=>{clearTimeout(imResizeTimer);if(layoutMode==='industry-map')imResizeTimer=setTimeout(imCenterRoot,100);});
async function imPersist(row,patch,extra) {
  const next={...imX(row),...extra,revision:crypto.randomUUID(),editedAt:new Date().toISOString(),editedBy:myName};
  const {data,error}=await sb.from('research_framework').update({...patch,extra:next,updated_at:next.editedAt}).eq('id',row.id).eq('extra->>kind',IM_KIND).eq('extra->>revision',imX(row).revision).select('*');
  if(error)throw error;
  if(!data?.length){await loadIndustryMap();throw new Error('这条记录已被其他人更新。你的输入仍在，请复制后关闭窗口，查看最新内容再编辑。');}
  imAllRows=imAllRows.map(r=>r.id===row.id?data[0]:r);imRefreshActive();return data[0];
}
function imNewRow(type,parentId,title,extra={},content='',id=crypto.randomUUID()) {
  return {id,theme:'行业研究地图',section:'tracking',title,content,author:myName,extra:{kind:IM_KIND,type,parentId,revision:crypto.randomUUID(),...extra}};
}
async function imInsert(rows) {
  const {data,error}=await sb.from('research_framework').insert(rows).select('*');
  if(error)throw error;if(!data?.length)throw new Error('没有收到保存结果，请刷新后检查。');
  const incoming=new Set(data.map(r=>r.id));imAllRows=[...imAllRows.filter(r=>!incoming.has(r.id)),...data];imRefreshActive();
  return data;
}
async function imSeed() {
  if(imBusy)return;imBusy=true;
  const root=imNewRow('sector',null,'电子');
  try{await imInsert([root,...['MLCC','存储','芯片设计','设备'].map(n=>imNewRow('industry',root.id,n))]);toast('✓ 已添加电子及四个细分行业');}
  catch(e){alert('添加失败：'+(e.message||e));}finally{imBusy=false;renderIndustryMap();}
}
async function imDelete(id){
  if(imBusy)return;await loadIndustryMap();if(imError){alert(imError);return;}const row=imRows.find(r=>r.id===id);if(!row)return;
  const branch=new Set([id]);for(let i=0;i<imRows.length;i++){let changed=false;for(const r of imRows)if(branch.has(imX(r).parentId)&&!branch.has(r.id)){branch.add(r.id);changed=true;}if(!changed)break;}
  if(!confirm(`删除「${imName(row)}」${branch.size>1?'及其下方全部分支（当前共 '+branch.size+' 条记录）':''}？\n删除后会从团队地图中移除，可通过“撤销上次删除”恢复。`))return;
  imBusy=true;try{await imPersist(row,{}, {deletedAt:new Date().toISOString(),deletedBy:myName});imLastDeleted=id;toast('✓ 已删除，可撤销上次删除');}catch(e){alert('删除失败：'+(e.message||e));}finally{imBusy=false;renderIndustryMap();}
}
async function imUndoDelete(){if(imBusy||!imLastDeleted)return;const row=imAllRows.find(r=>r.id===imLastDeleted);if(!row)return;imBusy=true;try{await imPersist(row,{}, {deletedAt:null,deletedBy:null});imLastDeleted=null;toast('✓ 已恢复');}catch(e){alert('恢复失败：'+(e.message||e));}finally{imBusy=false;renderIndustryMap();}}
async function imCheckParent(parentId){
  const seen=new Set();let id=parentId;
  while(id&&!seen.has(id)){seen.add(id);const {data,error}=await sb.from('research_framework').select('*').eq('id',id).eq('extra->>kind',IM_KIND).maybeSingle();if(error)throw error;if(!data||imX(data).deletedAt)throw new Error('所属分类已被删除，请关闭窗口刷新地图后重试。');id=imX(data).parentId;}
}
function imOpenCombined(parentId){
  const parent=imRows.find(r=>r.id===parentId);if(!parent)return;
  let dialog=document.getElementById('imDialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='imDialog';dialog.className='im-dialog';document.body.appendChild(dialog);}
  dialog.innerHTML=`<form id="imForm"><h2 id="imDialogTitle">添加个股与研究员</h2><div class="im-dialog-sub">所属：${imEsc(imName(parent))} · 可同时添加个股和多位券商研究员；不填个股时，研究员直接归入这个行业。</div><div class="im-split"><div><label for="imTitle">个股名称（可选）</label><input id="imTitle" maxlength="200" placeholder="输入股票名称"></div><div><label for="imCode">股票代码 / 市场（可选）</label><input id="imCode" maxlength="80" placeholder="代码 · A 股 / 港股 / 美股"></div></div><label for="imNote">个股说明（可选）</label><textarea id="imNote" maxlength="30000" placeholder="补充个股的关注点…"></textarea><div class="im-joint-heading">对应的券商研究员 <button type="button" class="im-action" id="imMorePerson">＋ 再添一位</button></div><div id="imJointPeople"></div><div class="im-form-error" id="imFormError" role="alert"></div><div class="im-dialog-foot"><button type="button" class="btn" id="imCancel">取消</button><button type="submit" class="btn primary" id="imSave">一起保存</button></div></form>`;
  dialog.setAttribute('aria-labelledby','imDialogTitle');
  function addPerson(){const wrap=document.createElement('div');wrap.className='im-joint-person';wrap.innerHTML='<div class="im-split"><label>券商名称<input data-broker maxlength="100" placeholder="例如：某某证券"></label><label>研究员姓名<input data-person maxlength="200" placeholder="研究员姓名"></label></div><label>擅长方向 / 推荐理由<input data-note maxlength="1000" placeholder="可选"></label><button type="button" class="im-action">移除这一位</button>';wrap.querySelector('button').onclick=()=>wrap.remove();dialog.querySelector('#imJointPeople').appendChild(wrap);}
  addPerson();dialog.querySelector('#imMorePerson').onclick=addPerson;dialog.querySelector('#imCancel').onclick=()=>{if(!imBusy)dialog.close();};dialog.oncancel=e=>{if(imBusy)e.preventDefault();};
  dialog.querySelector('#imForm').onsubmit=async e=>{
    e.preventDefault();if(imBusy)return;const title=dialog.querySelector('#imTitle').value.trim(),code=dialog.querySelector('#imCode').value.trim(),note=dialog.querySelector('#imNote').value.trim();
    const people=[...dialog.querySelectorAll('.im-joint-person')].map(el=>({broker:el.querySelector('[data-broker]').value.trim(),name:el.querySelector('[data-person]').value.trim(),note:el.querySelector('[data-note]').value.trim()})).filter(p=>p.broker||p.name||p.note);
    const err=dialog.querySelector('#imFormError');err.textContent='';
    if(people.some(p=>!p.broker||!p.name)){err.textContent='每位研究员请同时填写券商和姓名。';return;}
    if(!title&&!people.length){err.textContent='请填写个股，或至少填写一位券商研究员。';return;}
    if(!title&&(code||note)){err.textContent='填写个股代码或说明时，请同时填写个股名称。';return;}
    const stock=title?imNewRow('stock',parentId,title,{code},note):null,rows=stock?[stock]:[];
    people.forEach(p=>rows.push(imNewRow('analyst',stock?.id||parentId,p.name,{broker:p.broker},p.note)));
    imBusy=true;const controls=[...dialog.querySelectorAll('button,input,textarea')];controls.forEach(el=>el.disabled=true);dialog.querySelector('#imSave').textContent='保存中…';
    try{await imCheckParent(parentId);await imInsert(rows);imCollapsed.delete(parentId);dialog.close();toast('✓ 个股与研究员已一起保存');renderIndustryMap();}catch(e){err.textContent='保存失败：'+(e.message||e);}finally{imBusy=false;controls.forEach(el=>el.disabled=false);dialog.querySelector('#imSave').textContent='一起保存';}
  };dialog.showModal();
}
function imOpen(type,parentId,id) {
  const row=id?imRows.find(r=>r.id===id):null;if(id&&!row)return;
  const x=row?imX(row):{};type=row?x.type:type;parentId=row?x.parentId:parentId;
  if(!IM_TYPES[type])return;
  const parent=imRows.find(r=>r.id===parentId);
  if(!row&&type!=='sector'&&(!parent||!IM_TYPES[imX(parent).type]?.children.includes(type)))return;
  let dialog=document.getElementById('imDialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='imDialog';dialog.className='im-dialog';document.body.appendChild(dialog);}
  const model=type==='model',analyst=type==='analyst',stock=type==='stock',newId=crypto.randomUUID();
  dialog.innerHTML=`<form id="imForm"><h2 id="imDialogTitle">${row?'编辑':'添加'}${IM_TYPES[type].name}</h2><div class="im-dialog-sub">${parent?'所属：'+imEsc(imName(parent)):'最左侧的一级板块'} · 保存时自动记录填写人及日期</div>
    ${analyst?'<div class="im-split"><div><label for="imBroker">券商名称</label><input id="imBroker" maxlength="100" required placeholder="例如：某某证券"></div><div>':''}
    <label for="imTitle">${analyst?'研究员姓名':stock?'个股名称':model?'模型名称 / 版本':'分类名称'}</label><input id="imTitle" maxlength="200" required value="${imEsc(row?.title||'')}" placeholder="${analyst?'研究员姓名':stock?'输入股票名称':model?'例如：盈利预测模型 · 2026 年 9 月':type==='sector'?'例如：电子、医药、机械':'例如：MLCC、存储、芯片设计'}">${analyst?'</div></div>':''}
    ${stock?`<label for="imCode">股票代码 / 市场（可选）</label><input id="imCode" maxlength="80" value="${imEsc(x.code||'')}" placeholder="例如：代码 · A 股 / 港股 / 美股">`:''}
    <label for="imNote">${analyst?'擅长方向 / 推荐理由（可选）':model?'模型说明 / 关键假设（可选）':'补充说明（可选）'}</label><textarea id="imNote" maxlength="30000" placeholder="${analyst?'他 / 她擅长看什么？为什么值得跟踪？':'补充你希望团队看到的信息…'}">${imEsc(row?.content||'')}</textarea>
    ${model?`<label for="imLink">模型链接（可选）</label><input id="imLink" type="url" value="${imEsc(x.link||'')}" placeholder="https://…"><label for="imFiles">上传模型（可选）</label><input id="imFiles" type="file" accept=".xlsx,.xls,.csv,.pdf" multiple><div class="im-hint">支持 Excel、CSV、PDF；每个文件最多 20 MB，每条最多 10 个附件。说明、链接、附件至少填写一项。</div><div class="im-keep">${(x.files||[]).map((f,i)=>`<label><input type="checkbox" data-keep="${i}" checked> 保留 ${imEsc(f.name)}</label>`).join('')}</div>`:''}
    ${row?`<div class="im-hint">最初填写：${imEsc(row.author)} · ${rtTime(row.created_at)}${x.editedAt?'<br>最近修改：'+imEsc(x.editedBy||'')+' · '+rtTime(x.editedAt):''}</div>`:''}
    <div class="im-form-error" id="imFormError" role="alert"></div><div class="im-dialog-foot"><button type="button" class="btn" id="imCancel">取消</button><button type="submit" class="btn primary" id="imSave">保存</button></div></form>`;
  dialog.setAttribute('aria-labelledby','imDialogTitle');
  if(analyst)dialog.querySelector('#imBroker').value=x.broker||'';
  dialog.oncancel=e=>{if(imBusy)e.preventDefault();};
  dialog.querySelector('#imCancel').onclick=()=>{if(!imBusy)dialog.close();};
  dialog.querySelector('#imForm').onsubmit=async e=>{
    e.preventDefault();if(imBusy)return;
    const title=dialog.querySelector('#imTitle').value.trim(),content=dialog.querySelector('#imNote').value.trim();
    const extra={};if(analyst)extra.broker=dialog.querySelector('#imBroker').value.trim();if(stock)extra.code=dialog.querySelector('#imCode').value.trim();
    const files=model?[...dialog.querySelector('#imFiles').files]:[],kept=model?[...dialog.querySelectorAll('[data-keep]:checked')].map(el=>x.files[Number(el.dataset.keep)]):[];
    if(model)extra.link=dialog.querySelector('#imLink').value.trim();
    const errorEl=dialog.querySelector('#imFormError');errorEl.textContent='';
    if(!title||(analyst&&!extra.broker)){errorEl.textContent='请填写名称；研究员需要同时填写券商和姓名。';return;}
    if(model&&extra.link&&!imUrl(extra.link)){errorEl.textContent='请填写有效的 http 或 https 模型链接。';return;}
    if(model&&!content&&!extra.link&&!files.length&&!kept.length){errorEl.textContent='模型说明、链接或附件至少填写一项。';return;}
    if(files.length+kept.length>10){errorEl.textContent='每条模型最多保留 10 个附件。';return;}
    imBusy=true;const controls=[...dialog.querySelectorAll('button,input,textarea')];controls.forEach(el=>el.disabled=true);dialog.querySelector('#imSave').textContent='保存中…';
    const uploaded=[];
    try {
      if(parentId)await imCheckParent(parentId);
      for(const file of files){
        if(!/\.(xlsx|xls|csv|pdf)$/i.test(file.name)||!file.size||file.size>20*1024*1024)throw new Error('请上传非空的 Excel、CSV 或 PDF 文件，每个不超过 20 MB。');
        if(/\.pdf$/i.test(file.name))await rtValidatePdf(file);
      }
      for(const file of files){
        const ext=file.name.split('.').pop().toLowerCase();
        const path=`industry-map/${row?.id||newId}/${crypto.randomUUID()}.${ext}`;
        const mime={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',csv:'text/csv',pdf:'application/pdf'}[ext];
        const {error}=await sb.storage.from('attachments').upload(path,file,{contentType:mime,upsert:false});if(error)throw error;
        uploaded.push({name:file.name,path,url:sb.storage.from('attachments').getPublicUrl(path).data.publicUrl});
      }
      if(model)extra.files=[...kept,...uploaded];
      if(row)await imPersist(row,{title,content},extra);
      else await imInsert(imNewRow(type,parentId,title,extra,content,newId));
      if(parentId)imCollapsed.delete(parentId);dialog.close();toast('✓ 已保存到团队地图');renderIndustryMap();
    }catch(e){
      errorEl.textContent='保存失败：'+(e.message||e);
      if(uploaded.length){try{
        const {data,error}=await sb.from('research_framework').select('extra').eq('id',row?.id||newId).maybeSingle();
        if(!error){const refs=new Set((data?.extra?.files||[]).map(f=>f.path));const unused=uploaded.map(f=>f.path).filter(p=>!refs.has(p));if(unused.length)await sb.storage.from('attachments').remove(unused);}
      }catch(_){} }
    }finally{imBusy=false;controls.forEach(el=>el.disabled=false);dialog.querySelector('#imSave').textContent='保存';}
  };
  dialog.showModal();
}
function imMarkdown() {
  const lines=['# 行业研究地图','',`导出时间：${rtTime(new Date().toISOString())}（北京时间）`,''];
  const ids=new Set(imRows.map(r=>r.id)),seen=new Set();
  function visit(r,depth){if(seen.has(r.id))return;seen.add(r.id);const x=imX(r),indent='  '.repeat(depth);
    lines.push(`${indent}- **${rtMd(imName(r))}**（${IM_TYPES[x.type]?.name||'分类'}）`);
    if(x.code)lines.push(`${indent}  - 代码：${rtMd(x.code)}`);
    if(r.content)lines.push(`${indent}  - 说明：${rtMd(r.content)}`);
    if(imUrl(x.link))lines.push(`${indent}  - [模型链接](<${imUrl(x.link).replace(/>/g,'%3E').replace(/</g,'%3C')}>)`);
    (x.files||[]).forEach(f=>{if(imUrl(f.url))lines.push(`${indent}  - [${rtMd(f.name)}](<${imUrl(f.url).replace(/>/g,'%3E').replace(/</g,'%3C')}>)`);});
    lines.push(`${indent}  - 填写：${rtMd(r.author)} · ${rtTime(r.created_at)}`);
    if(x.editedAt)lines.push(`${indent}  - 修改：${rtMd(x.editedBy)} · ${rtTime(x.editedAt)}`);
    imChildren(r.id).forEach(c=>visit(c,depth+1));
  }
  imRows.filter(r=>!imX(r).parentId||!ids.has(imX(r).parentId)).forEach(r=>visit(r,0));
  imRows.filter(r=>!seen.has(r.id)).forEach(r=>visit(r,0));return lines.join('\n')+'\n';
}
async function imExport(){
  await loadIndustryMap();if(imError){alert('同步失败，请重试后导出。');return;}
  const url=URL.createObjectURL(new Blob(['\uFEFF'+imMarkdown()],{type:'text/markdown;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`行业研究地图-${rtTime(new Date().toISOString()).slice(0,10)}.md`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

const imOriginalRender=render;
render=function(){
  const active=layoutMode==='industry-map';document.body.classList.toggle('im-active',active);document.getElementById('board').classList.toggle('im-mode',active);
  if(active){document.body.classList.remove('tasks-active');document.getElementById('board').classList.remove('tasks-mode','single-mode','list-mode','coverage-mode','home-mode','framework-mode','calendar-mode');renderIndustryMap();}
  else imOriginalRender();
};
const imOriginalGo=goMode;
goMode=function(mode){if(mode==='industry-map')history.replaceState(null,'','#industry-map');else if(location.hash==='#industry-map')history.replaceState(null,'',location.pathname+location.search);imOriginalGo(mode);if(mode==='industry-map')loadIndustryMap();};
const imOriginalStart=startApp;
startApp=function(){const direct=location.hash==='#industry-map';imOriginalStart();if(direct)goMode('industry-map');};
const imOriginalRefresh=manualRefresh;
manualRefresh=async function(){if(layoutMode==='industry-map'){await loadIndustryMap();if(!imError)toast('✓ 地图已刷新');}else await imOriginalRefresh();};
window.addEventListener('hashchange',()=>{if(location.hash==='#industry-map'&&myName)goMode('industry-map');});
setInterval(()=>{if(myName&&layoutMode==='industry-map'&&document.visibilityState==='visible')loadIndustryMap();},30000);
window.addEventListener('online',()=>{if(myName&&layoutMode==='industry-map')loadIndustryMap();});
document.addEventListener('visibilitychange',()=>{if(myName&&layoutMode==='industry-map'&&document.visibilityState==='visible')loadIndustryMap();});
