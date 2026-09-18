/* Each task is an isolated research_framework row, identified by extra.kind.
 * Existing tracking rows and existing attachments are never rewritten.
 * A per-row revision provides optimistic concurrency for team edits.
 */
const RT_KIND = 'research-task-v1';
let rtRows = [], rtLoaded = false, rtError = '', rtLoading = null;
let rtFilter = {status:'all', industry:'', owner:'', keyword:''};
const rtBusy = new Set();
let rtDialogBusy = false;
let rtRendering = false;
const rtEscape = value => escapeHtml(String(value ?? '')).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const rtExtra = row => row.extra || {};
const rtStatus = row => rtExtra(row).deliveredAt ? 'done' : rtExtra(row).owner ? 'active' : 'pending';
const rtStatusName = row => ({pending:'待承接',active:'研究中',done:'已交付'})[rtStatus(row)];
function rtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
}
function rtIndustries() {
  return uniq([...allL2, ...posts.flatMap(p => p.l2 || []), ...(coverage.themes || []).flatMap(t => t.subs.map(s => s.name)), ...rtRows.map(r => rtExtra(r).industry)].filter(Boolean)).sort((a,b)=>a.localeCompare(b,'zh'));
}
function rtOptions(values, current, placeholder) {
  return `<option value="">${rtEscape(placeholder)}</option>` + values.map(v=>`<option value="${rtEscape(v)}" ${v===current?'selected':''}>${rtEscape(v)}</option>`).join('');
}
function rtIndustryList(id){return `<datalist id="${id}">${rtIndustries().map(v=>`<option value="${rtEscape(v)}"></option>`).join('')}</datalist>`;}
function rtDuration(row){const x=rtExtra(row);if(!x.acceptedAt||!x.deliveredAt)return null;const ms=Date.parse(x.deliveredAt)-Date.parse(x.acceptedAt);return Number.isFinite(ms)&&ms>=0?ms:null;}
function rtDurationText(ms){if(ms===null||!Number.isFinite(ms))return '—';if(ms<60000)return '不足 1 分钟';const m=Math.floor(ms/60000),d=Math.floor(m/1440),h=Math.floor(m%1440/60),n=m%60;return [d?d+' 天':'',h?h+' 小时':'',n?n+' 分钟':''].filter(Boolean).join(' ');}
function rtDeliveryStats(rows){const groups=new Map();for(const r of rows){const x=rtExtra(r);if(!x.deliveredAt)continue;const name=x.deliveredBy||'未记录交付人';if(!groups.has(name))groups.set(name,{name,count:0,timed:0,total:0});const g=groups.get(name);g.count++;const duration=rtDuration(r);if(duration!==null){g.total+=duration;g.timed++;}}return [...groups.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh'));}
function rtStatsHtml(rows){const groups=rtDeliveryStats(rows),timed=groups.reduce((a,g)=>a+g.timed,0),total=groups.reduce((a,g)=>a+g.total,0);return `<section class="rt-delivery-stats" aria-label="交付用时统计"><h2>交付用时统计 <span>当前筛选范围</span></h2><p>共交付 ${groups.reduce((a,g)=>a+g.count,0)} 项 · 累计用时 ${rtDurationText(timed?total:null)} · 平均用时 ${rtDurationText(timed?total/timed:null)}</p><div class="rt-scroll"><table><thead><tr><th>交付研究员</th><th>交付任务数</th><th>可计时任务数</th><th>累计交付用时</th><th>平均交付用时</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${rtEscape(g.name)}</td><td>${g.count}</td><td>${g.timed}</td><td>${rtDurationText(g.timed?g.total:null)}</td><td>${rtDurationText(g.timed?g.total/g.timed:null)}</td></tr>`).join('')||'<tr><td colspan="5">暂无已交付任务</td></tr>'}</tbody></table></div><div class="rt-note">用时 = 承接时间至最近一次交付的自然时间，含夜间和周末；累计为各任务用时之和，并非工时。缺少时间或时间异常的任务不计入用时与平均值。</div></section>`;}
function rtVisible() {
  const kw = rtFilter.keyword.trim().toLocaleLowerCase();
  return rtRows.filter(r => {
    const x=rtExtra(r);
    return !x.archived && (rtFilter.status==='all' || rtStatus(r)===rtFilter.status)
      && (!rtFilter.industry || x.industry===rtFilter.industry)
      && (!rtFilter.owner || x.owner===rtFilter.owner)
      && (!kw || [r.title,x.industry,x.owner,x.deliverySummary,x.deliveredBy,x.deliveryText,...(x.pdfs||[]).map(p=>p.name)].join(' ').toLocaleLowerCase().includes(kw));
  });
}
async function loadResearchTasks() {
  if (!sb) return;
  if (rtLoading) return rtLoading;
  rtLoading = (async()=>{
    try {
      const rows=[];
      for (let offset=0;;offset+=500) {
        const {data,error}=await sb.from('research_framework').select('*').eq('extra->>kind',RT_KIND).order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+499);
        if(error) throw error;
        rows.push(...(data||[]));
        if(!data || data.length<500) break;
      }
      rtRows=rows; rtLoaded=true; rtError='';
    } catch(e) { rtError='任务同步失败，请检查网络后重试。'+(e.message||e); }
    finally { rtLoading=null; if(layoutMode==='tasks') renderResearchTasks(); }
  })();
  return rtLoading;
}
function rtSafeUrl(value) {
  try { const u=new URL(value); return u.protocol==='https:' ? u.href : ''; } catch { return ''; }
}
function rtFilesHtml(pdfs) {
  return (pdfs||[]).map(p=>{
    const url=rtSafeUrl(p.url);
    return url?`<a class="rt-pdf" href="${rtEscape(url)}" target="_blank" rel="noopener noreferrer">↗ ${rtEscape(p.name)}</a>`:'';
  }).join('');
}
function rtRowHtml(row,index) {
  const x=rtExtra(row), busy=rtBusy.has(row.id), done=rtStatus(row)==='done';
  return `<tr data-id="${rtEscape(row.id)}">
    <td><div class="rt-question">${rtEscape(row.title)}</div><div class="rt-meta"><span class="rt-status ${rtStatus(row)}">${rtStatusName(row)}</span> ${String(index+1).padStart(2,'0')} · ${rtEscape(row.author)} 提出</div><button class="rt-link" data-action="edit" ${busy?'disabled':''}>编辑问题</button></td>
    <td><input aria-label="细分行业" data-field="industry" list="rtIndustriesList" maxlength="60" value="${rtEscape(x.industry||'')}" placeholder="输入或选择行业" ${busy?'disabled':''}></td>
    <td><select aria-label="承接研究员" data-field="owner" ${busy||done?'disabled':''} title="${done?'已交付任务保留原承接人':'选择后自动记录当前承接时间'}">${rtOptions(users.map(u=>u.n),x.owner,'待承接')}</select></td>
    <td class="rt-date">${rtEscape(rtTime(x.acceptedAt)).replace(' ','<br>')}<div class="rt-meta">${x.acceptedAt?'自动记录':'选择研究员后记录'}</div></td>
    <td>${x.deliverySummary?`<div class="rt-conclusion">${rtEscape(x.deliverySummary)}</div>`:''}${done?`<div class="rt-delivered-by">交付研究员：${rtEscape(x.deliveredBy||'未记录')}</div>`:''}${x.deliveryText?`<div class="rt-result">${rtEscape(x.deliveryText)}</div>`:''}${rtFilesHtml(x.pdfs)}${!done?'<div class="rt-muted">尚未交付</div>':''}<button class="rt-link" data-action="deliver" ${busy||!x.owner?'disabled':''}>${done?'查看 / 更新交付':'＋ 提交交付'}</button></td>
    <td class="rt-date">${rtEscape(rtTime(x.deliveredAt)).replace(' ','<br>')}${x.deliveredAt?'<div class="rt-meta">最近一次交付</div>':''}</td>
    <td class="rt-duration">${rtDurationText(rtDuration(row))}</td>
  </tr>`;
}
function renderResearchTasks() {
  if(rtRendering)return;rtRendering=true;
  try {
  const board=document.getElementById('board');
  const active=rtRows.filter(r=>!rtExtra(r).archived), list=rtVisible();
  // Preserve search focus and caret across filtering and background refreshes.
  const focus=document.activeElement, selection=focus?.id==='rtSearch'?[focus.selectionStart,focus.selectionEnd]:null;
  const focusId=board.contains(focus)?focus.id:null;
  const industryDraft=board.contains(focus)&&focus.matches('input[data-field=industry]')&&!rtBusy.has(focus.closest('tr').dataset.id)?{id:focus.closest('tr').dataset.id,value:focus.value,start:focus.selectionStart,end:focus.selectionEnd}:null;
  board.innerHTML=`<div class="rt-wrap">${rtIndustryList('rtIndustriesList')}
    <div class="rt-eyebrow">RESEARCH WORKSPACE / 研究协作</div>
    <div class="rt-heading"><div><h1>研究任务</h1><p>把值得研究的问题留下来，让每一次探索都有回应。</p></div><div class="rt-actions"><button class="btn" id="rtExport" ${!rtLoaded||rtError?'disabled':''}>↓ 导出 Markdown</button><button class="btn primary" id="rtNew" ${!rtLoaded||rtError?'disabled':''}>＋ 添加问题</button></div></div>
    <div class="rt-stats">${[['全部任务',active.length,'#8a91a3'],['待承接',active.filter(r=>rtStatus(r)==='pending').length,'#b69b60'],['研究中',active.filter(r=>rtStatus(r)==='active').length,'#7664dd'],['已交付',active.filter(r=>rtStatus(r)==='done').length,'#4da67d']].map(([label,n,color])=>`<div class="rt-stat"><span><i style="background:${color}"></i>${label}</span><strong>${rtLoaded?n:'—'}</strong></div>`).join('')}</div>
    ${rtError?`<div class="rt-error" role="alert">${rtEscape(rtError)} <button class="rt-link" id="rtRetry">重新同步</button></div>`:''}
    <section class="rt-panel" aria-label="研究任务清单"><div class="rt-task-toolbar"><div class="rt-tabs" role="group" aria-label="任务状态">${[['all','全部'],['pending','待承接'],['active','研究中'],['done','已交付']].map(([s,n])=>`<button class="rt-tab ${rtFilter.status===s?'on':''}" data-status="${s}" aria-pressed="${rtFilter.status===s}">${n}</button>`).join('')}</div><input class="search" id="rtSearch" aria-label="搜索任务" placeholder="搜索问题、交付结果…" value="${rtEscape(rtFilter.keyword)}"><select id="rtIndustryFilter" aria-label="筛选细分行业">${rtOptions(rtIndustries(),rtFilter.industry,'全部细分行业')}</select><select id="rtOwnerFilter" aria-label="筛选研究员">${rtOptions(users.map(u=>u.n),rtFilter.owner,'全部研究员')}</select></div>
    <div class="rt-scroll"><table class="rt-task-table"><colgroup><col style="width:21%"><col style="width:12%"><col style="width:10%"><col style="width:12%"><col style="width:23%"><col style="width:12%"><col style="width:10%"></colgroup><thead><tr><th scope="col">研究问题</th><th scope="col">细分行业</th><th scope="col">承接研究员</th><th scope="col">承接时间</th><th scope="col">交付信息 / 结果</th><th scope="col">交付日期</th><th scope="col">交付用时</th></tr></thead><tbody>${list.map(rtRowHtml).join('')}</tbody></table></div>
    ${!list.length?`<div class="rt-empty"><b>${!rtLoaded?'正在同步任务…':active.length?'没有符合条件的任务':'从一个好问题开始'}</b>${!rtLoaded?'':active.length?'试试其他关键词或筛选条件。':'点击「添加问题」，选择细分行业，等待研究员承接。'}</div>`:''}
    <div class="rt-foot"><span>显示 ${list.length} / ${active.length} 项任务</span><span>${rtError?'同步异常':rtLoaded?'● 已与团队云端同步':'连接中…'} · 时间均为北京时间</span></div></section>
    <p class="rt-note">选择研究员后自动记录承接时间；提交文字或 PDF 后自动记录交付日期。导出包含全部任务及 PDF 链接，不受当前筛选影响。</p>
    ${rtStatsHtml(list)}
  </div>`;
  board.querySelector('#rtNew').onclick=()=>rtOpenQuestion();
  board.querySelector('#rtExport').onclick=rtExport;
  board.querySelector('#rtRetry')?.addEventListener('click',loadResearchTasks);
  board.querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>{rtFilter.status=b.dataset.status;renderResearchTasks();});
  board.querySelector('#rtSearch').oninput=e=>{rtFilter.keyword=e.target.value;renderResearchTasks();};
  board.querySelector('#rtIndustryFilter').onchange=e=>{rtFilter.industry=e.target.value;renderResearchTasks();};
  board.querySelector('#rtOwnerFilter').onchange=e=>{rtFilter.owner=e.target.value;renderResearchTasks();};
  board.querySelectorAll('tr[data-id]').forEach(tr=>{
    tr.querySelectorAll('[data-field]').forEach(el=>el.onchange=()=>{if(!rtRendering)rtChange(tr.dataset.id,el.dataset.field,el.value);});
    tr.querySelector('[data-action=edit]').onclick=()=>rtOpenQuestion(tr.dataset.id);
    tr.querySelector('[data-action=deliver]').onclick=()=>rtOpenDelivery(tr.dataset.id);
  });
  if(focusId) { const el=document.getElementById(focusId); el?.focus(); if(selection) el?.setSelectionRange(...selection); }
  if(industryDraft){const el=board.querySelector(`tr[data-id="${CSS.escape(industryDraft.id)}"] input[data-field=industry]`);if(el){el.value=industryDraft.value;el.focus({preventScroll:true});el.setSelectionRange(industryDraft.start,industryDraft.end);}}
  } finally {rtRendering=false;}
}
async function rtPersist(row, patch, extraPatch) {
  const next={...rtExtra(row),...extraPatch,revision:crypto.randomUUID()};
  let query=sb.from('research_framework').update({...patch,extra:next,updated_at:new Date().toISOString()}).eq('id',row.id).eq('extra->>kind',RT_KIND).eq('extra->>revision',rtExtra(row).revision);
  const {data,error}=await query.select('*');
  if(error) throw error;
  if(!data?.length) {
    await loadResearchTasks();
    throw new Error('这条任务已被其他人更新。你的输入仍保留，请先复制内容，再关闭窗口查看最新任务后重试。');
  }
  rtRows=rtRows.map(r=>r.id===row.id?data[0]:r);
  return data[0];
}
async function rtChange(id,field,value) {
  if(field==='industry')value=value.trim().slice(0,60);
  const row=rtRows.find(r=>r.id===id); if(!row||rtBusy.has(id)) return;
  const x=rtExtra(row); if(x[field]===value) return;
  if(field==='industry'&&!value) { renderResearchTasks(); return; }
  if(field==='owner'&&x.deliveredAt) {renderResearchTasks();return;}
  if(field==='owner'&&x.owner&&!confirm(value?'更换承接研究员后，将以现在的时间重新记录承接时间。继续吗？':'取消承接后，任务回到待承接，承接时间将清空。继续吗？')) {renderResearchTasks();return;}
  rtBusy.add(id); renderResearchTasks();
  try {
    await rtPersist(row,{},field==='owner'?{owner:value,acceptedAt:value?new Date().toISOString():null}:{industry:value});
    toast('✓ 已同步到团队');
  } catch(e) {alert('保存失败：'+(e.message||e));}
  finally {rtBusy.delete(id);renderResearchTasks();}
}
function rtDialog(title,subtitle,body) {
  let dialog=document.getElementById('rtDialog');
  if(!dialog) {dialog=document.createElement('dialog');dialog.id='rtDialog';dialog.className='rt-dialog';document.body.appendChild(dialog);}
  dialog.innerHTML=`<form id="rtForm"><h2 id="rtDialogTitle">${title}</h2><p>${subtitle}</p>${body}<div class="rt-form-error" role="alert" id="rtFormError"></div><div class="rt-actions"><button type="button" class="btn" id="rtCancel">取消</button><button type="submit" class="btn primary" id="rtSave">保存</button></div></form>`;
  dialog.setAttribute('aria-labelledby','rtDialogTitle');
  dialog.oncancel=e=>{if(rtDialogBusy)e.preventDefault();};
  document.getElementById('rtCancel').onclick=()=>{if(!rtDialogBusy)dialog.close();};
  dialog.showModal();
  return dialog;
}
async function rtSubmit(dialog,action) {
  if(rtDialogBusy)return;
  rtDialogBusy=true;
  const controls=[...dialog.querySelectorAll('input,textarea,select,button')];
  controls.forEach(el=>el.disabled=true);
  document.getElementById('rtSave').textContent='保存中…';
  document.getElementById('rtFormError').textContent='';
  try {await action();dialog.close();toast('✓ 已保存到团队云端');renderResearchTasks();}
  catch(e){document.getElementById('rtFormError').textContent='保存失败：'+(e.message||e);}
  finally {rtDialogBusy=false;controls.forEach(el=>el.disabled=false);document.getElementById('rtSave').textContent='保存';}
}
function rtOpenQuestion(id) {
  const row=id?rtRows.find(r=>r.id===id):null, x=row?rtExtra(row):{};
  const dialog=rtDialog(row?'编辑研究问题':'添加研究问题','先记录问题，再由研究员承接。也可以在创建时选择承接人。',`
    <label for="rtQuestion">研究问题</label><textarea id="rtQuestion" maxlength="10000" required placeholder="例如：未来两年，液冷在数据中心的渗透率会如何变化？">${rtEscape(row?.title||'')}</textarea>
    <div class="rt-split"><div><label for="rtIndustry">细分行业</label><input type="text" id="rtIndustry" list="rtDialogIndustries" maxlength="60" required value="${rtEscape(x.industry||'')}" placeholder="输入或选择细分行业">${rtIndustryList('rtDialogIndustries')}</div><div><label for="rtOwner">承接研究员</label>${row?`<p style="margin:8px 0">${rtEscape(x.owner||'待承接')}（在清单中选择）</p>`:`<select id="rtOwner">${rtOptions(users.map(u=>u.n),'','暂不指定')}</select>`}</div></div>`);
  document.getElementById('rtForm').onsubmit=e=>{
    e.preventDefault();
    const title=document.getElementById('rtQuestion').value.trim();
    const industry=document.getElementById('rtIndustry').value.trim();
    if(!title||!industry) {document.getElementById('rtFormError').textContent='请填写问题并选择或输入细分行业。';return;}
    const owner=row?x.owner:document.getElementById('rtOwner').value;
    rtSubmit(dialog,async()=>{
      if(row) await rtPersist(row,{title},{industry});
      else {
        const now=new Date().toISOString();
        const {data,error}=await sb.from('research_framework').insert({theme:'研究任务',section:'tracking',title,content:'',author:myName,extra:{kind:RT_KIND,revision:crypto.randomUUID(),industry,owner,acceptedAt:owner?now:null,deliveryText:'',pdfs:[],deliveredAt:null,archived:false}}).select('*');
        if(error)throw error;
        if(!data?.length)throw new Error('未收到云端保存结果，请刷新检查后重试。');
        rtRows.unshift(data[0]);
      }
    });
  };
}
async function rtValidatePdf(file) {
  if(!/\.pdf$/i.test(file.name)) throw new Error('仅支持 PDF 文件：'+file.name);
  if(!file.size||file.size>20*1024*1024) throw new Error('PDF 文件不能为空，且每个不超过 20 MB：'+file.name);
  const header=new TextDecoder().decode(await file.slice(0,1024).arrayBuffer());
  if(!header.includes('%PDF-')) throw new Error('文件不是有效的 PDF：'+file.name);
}
function rtOpenDelivery(id) {
  const row=rtRows.find(r=>r.id===id); if(!row||!rtExtra(row).owner)return;
  const x=rtExtra(row);
  const dialog=rtDialog('交付研究结果',rtEscape(row.title),`
    <label for="rtDeliverySummary">一句话总结论</label><input type="text" id="rtDeliverySummary" maxlength="500" required value="${rtEscape(x.deliverySummary||'')}" placeholder="用一句话说清楚这次研究的核心结论">
    <label for="rtDeliveredBy">交付研究员</label><select id="rtDeliveredBy" required>${rtOptions(users.map(u=>u.n),x.deliveredBy||myName,'选择交付研究员')}</select>
    <label for="rtDeliveryText">文字结果</label><textarea id="rtDeliveryText" maxlength="100000" placeholder="写下研究结论、依据和后续值得追踪的问题…">${rtEscape(x.deliveryText||'')}</textarea>
    <label for="rtDeliveryFiles">PDF 附件（可选，可多选）</label><input type="file" id="rtDeliveryFiles" accept=".pdf,application/pdf" multiple>
    <div class="rt-meta">总结论必填；可补充详细文字或 PDF。每个 PDF 不超过 20 MB，最多保留 10 个附件。</div>
    <div class="rt-existing">${(x.pdfs||[]).map((p,i)=>`<label><input type="checkbox" data-keep="${i}" checked>保留 ${rtEscape(p.name)}</label>`).join('')}</div>`);
  document.getElementById('rtSave').textContent='提交交付';
  document.getElementById('rtForm').onsubmit=e=>{
    e.preventDefault();
    const deliveryText=document.getElementById('rtDeliveryText').value.trim();
    const deliverySummary=document.getElementById('rtDeliverySummary').value.trim(),deliveredBy=document.getElementById('rtDeliveredBy').value;
    const files=[...document.getElementById('rtDeliveryFiles').files];
    const kept=[...dialog.querySelectorAll('[data-keep]:checked')].map(el=>x.pdfs[Number(el.dataset.keep)]);
    if(!deliverySummary||!deliveredBy){document.getElementById('rtFormError').textContent='请填写一句话总结论并选择交付研究员。';return;}
    if(files.length+kept.length>10){document.getElementById('rtFormError').textContent='最多保留 10 个 PDF 附件。';return;}
    if(deliverySummary===(x.deliverySummary||'')&&deliveredBy===x.deliveredBy&&deliveryText===(x.deliveryText||'')&&!files.length&&kept.length===(x.pdfs||[]).length){dialog.close();return;}
    rtSubmit(dialog,async()=>{
      for(const file of files)await rtValidatePdf(file);
      const uploaded=[];
      try {
        for(const file of files) {
          const path=`research-tasks/${row.id}/${crypto.randomUUID()}.pdf`;
          const {error}=await sb.storage.from('attachments').upload(path,file,{contentType:'application/pdf',upsert:false});
          if(error)throw error;
          uploaded.push({name:file.name,url:sb.storage.from('attachments').getPublicUrl(path).data.publicUrl,path});
        }
        await rtPersist(row,{}, {deliverySummary,deliveredBy,deliveryText,pdfs:[...kept,...uploaded],deliveredAt:new Date().toISOString()});
      } catch(e) {
        // A response can be lost after a successful write. Only delete newly
        // uploaded files after checking the authoritative row for references.
        if(uploaded.length) {
          try {
            const {data,error}=await sb.from('research_framework').select('extra').eq('id',row.id).single();
            if(!error&&data) {
              const referenced=new Set((data.extra?.pdfs||[]).map(p=>p.path));
              const unused=uploaded.map(p=>p.path).filter(p=>!referenced.has(p));
              if(unused.length)await sb.storage.from('attachments').remove(unused);
            }
          }catch(_) { /* Retain files when the server state cannot be verified. */ }
        }
        throw e;
      }
    });
  };
}
function rtMd(value) {
  return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\/g,'\\\\').replace(/([`*_{}\[\]()#+.!|~-])/g,'\\$1').replace(/\r?\n/g,'<br>');
}
function rtMarkdown(rows=rtRows.filter(r=>!rtExtra(r).archived)) {
  const lines=['# 研究任务','',`导出时间：${rtTime(new Date().toISOString())}（北京时间）`,`任务总数：${rows.length} · 待承接：${rows.filter(r=>rtStatus(r)==='pending').length} · 研究中：${rows.filter(r=>rtStatus(r)==='active').length} · 已交付：${rows.filter(r=>rtStatus(r)==='done').length}`,'','| 研究问题 | 细分行业 | 承接研究员 | 承接时间 | 总结论 | 交付研究员 | 交付结果 | 交付日期 | 交付用时 |','| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  rows.forEach(r=>{
    const x=rtExtra(r), links=(x.pdfs||[]).filter(p=>rtSafeUrl(p.url)).map(p=>`[${rtMd(p.name)}](<${rtSafeUrl(p.url).replace(/>/g,'%3E').replace(/</g,'%3C')}>)`);
    lines.push(`| ${rtMd(r.title)} | ${rtMd(x.industry)} | ${rtMd(x.owner||'待承接')} | ${rtTime(x.acceptedAt)} | ${rtMd(x.deliverySummary||'—')} | ${rtMd(x.deliveredBy||(x.deliveredAt?'未记录':'—'))} | ${[rtMd(x.deliveryText),...links].filter(Boolean).join('<br>')||(x.deliveredAt?'仅总结论':'尚未交付')} | ${rtTime(x.deliveredAt)} | ${rtDurationText(rtDuration(r))} |`);
  });
  lines.push('','## 任务详情','');
  rows.forEach((r,i)=>{
    const x=rtExtra(r);
    lines.push(`### ${i+1}. ${rtMd(r.title)}`,'',`- 状态：${rtStatusName(r)}`,`- 提出人：${rtMd(r.author)}`,`- 提出时间：${rtTime(r.created_at)}`,`- 细分行业：${rtMd(x.industry)}`,`- 承接研究员：${rtMd(x.owner||'待承接')}`,`- 承接时间：${rtTime(x.acceptedAt)}`,`- 总结论：${rtMd(x.deliverySummary||'—')}`,`- 交付研究员：${rtMd(x.deliveredBy||'未记录')}`,`- 交付用时：${rtDurationText(rtDuration(r))}`,`- 交付日期：${rtTime(x.deliveredAt)}`,'','**交付结果**','',x.deliveryText?rtMd(x.deliveryText):'无补充文字','');
    (x.pdfs||[]).forEach(p=>{const url=rtSafeUrl(p.url);if(url)lines.push(`- PDF：[${rtMd(p.name)}](<${url.replace(/>/g,'%3E').replace(/</g,'%3C')}>)`);});
    lines.push('');
  });
  lines.push('## 交付用时统计','','| 交付研究员 | 交付任务数 | 可计时任务数 | 累计用时 | 平均用时 |','| --- | --- | --- | --- | --- |');
  for(const g of rtDeliveryStats(rows))lines.push(`| ${rtMd(g.name)} | ${g.count} | ${g.timed} | ${rtDurationText(g.timed?g.total:null)} | ${rtDurationText(g.timed?g.total/g.timed:null)} |`);
  lines.push('','用时按承接至最近一次交付的自然时间计算，含夜间和周末；累计为任务用时之和，并非实际工时。缺少时间或时间异常的记录不计入用时与平均值。','');
  lines.push('---','导出包含全部任务的完整文字与 PDF 链接；PDF 文件保存在原站附件空间。','');
  return lines.join('\n');
}
async function rtExport() {
  await loadResearchTasks();
  if(rtError){alert('导出前同步失败，请重试以获取完整清单。');return;}
  const a=document.createElement('a');
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rtMarkdown()],{type:'text/markdown;charset=utf-8'}));
  a.href=url;a.download=`研究任务-${rtTime(new Date().toISOString()).slice(0,10)}.md`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('✓ 已导出全部研究任务');
}

// Integrate with the existing navigation and refresh lifecycle.
const rtOriginalRender=render;
render=function() {
  const active=layoutMode==='tasks';
  document.body.classList.toggle('tasks-active',active);
  document.getElementById('board').classList.toggle('tasks-mode',active);
  if(active) {
    document.getElementById('board').classList.remove('single-mode','list-mode','coverage-mode','home-mode','framework-mode','calendar-mode');
    renderResearchTasks();
  } else rtOriginalRender();
};
const rtOriginalButtons=updateLayoutButtons;
updateLayoutButtons=function() {
  rtOriginalButtons();
  document.getElementById('tasksBtn').classList.toggle('primary',layoutMode==='tasks');
  if(layoutMode!=='tasks'&&location.hash==='#tasks')history.replaceState(null,'',location.pathname+location.search);
};
const rtOriginalGoMode=goMode;
goMode=function(mode) {
  if(mode==='tasks')history.replaceState(null,'','#tasks');
  rtOriginalGoMode(mode);
  if(mode==='tasks')loadResearchTasks();
};
const rtOriginalStart=startApp;
startApp=function() {
  const direct=location.hash==='#tasks';
  rtOriginalStart();
  if(direct)goMode('tasks');else loadResearchTasks();
};
const rtOriginalRefresh=manualRefresh;
manualRefresh=async function() {
  if(layoutMode==='tasks') {await loadResearchTasks();if(!rtError)toast('✓ 任务已刷新');}
  else await rtOriginalRefresh();
};
window.addEventListener('hashchange',()=>{if(location.hash==='#tasks'&&myName)goMode('tasks');});
setInterval(()=>{if(myName&&layoutMode==='tasks'&&document.visibilityState==='visible')loadResearchTasks();},30000);
window.addEventListener('online',()=>{if(myName)loadResearchTasks();});
document.addEventListener('visibilitychange',()=>{if(myName&&layoutMode==='tasks'&&document.visibilityState==='visible')loadResearchTasks();});
