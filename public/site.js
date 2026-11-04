// Published Chrome Web Store listing.
const STORE_URL = "https://chromewebstore.google.com/detail/gffkdnbgdhploafkibimgnhlpgbiaeam";

document.querySelectorAll('[data-store]').forEach(link => {
  link.href = STORE_URL; link.target = '_blank'; link.rel = 'noopener';
});
const previewFrame=document.querySelector('.popup-example iframe');
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===previewFrame.contentWindow&&event.data?.type==='traced-preview-height'&&Number.isFinite(event.data.height))previewFrame.style.height=Math.min(600,Math.max(280,event.data.height+6))+'px';});

// Website-only example details. No tracking API calls are made by this demo.
const detailExamples=[{"title":"Read to the end","to":"john@example.com","opens":1,"hits":4,"reads":1,"clicks":4,"sessions":1,"last":"12m ago","where":"Click: Paris, France (approx.)"},{"title":"Opened","to":"sarah@example.com","opens":1,"hits":2,"reads":0,"clicks":0,"sessions":0,"last":"40m ago","where":"Location unavailable (mail proxy)"},{"title":"Not opened yet","to":"marcus@example.com","opens":0,"hits":0,"reads":0,"clicks":0,"sessions":0,"last":"","where":""}];
const detailSubjects=['Partnership Proposal — Q3 Initiative','Summer Research Program — Application','Internship Opportunity at Nexus Labs'];
const detailDialog=document.getElementById('demo-details');
document.querySelectorAll('.traced-badge').forEach((badge,index)=>{
  const tip=badge.querySelector('.t-tip');tip.id='example-tip-'+index;badge.setAttribute('aria-describedby',tip.id);badge.setAttribute('aria-haspopup','dialog');badge.removeAttribute('aria-expanded');
  const open=()=>{const e=detailExamples[index];document.getElementById('details-title').textContent=detailSubjects[index];document.getElementById('details-recipient').textContent='To '+e.to;const stats=document.getElementById('details-stats');stats.replaceChildren();for(const [number,label] of [[e.opens,'Opens'],[e.reads,'Read'],[e.clicks,'Clicks']]){const cell=document.createElement('div'),strong=document.createElement('strong'),span=document.createElement('span');strong.textContent=number;span.textContent=label;cell.append(strong,span);stats.append(cell);}const body=document.getElementById('details-body');body.replaceChildren();const p=document.createElement('p');p.textContent=e.opens?(e.title+' · Gmail · Last seen '+e.last):'No activity yet. Opens and clicks show up here as they happen.';body.append(p);if(e.clicks){const click=document.createElement('p');click.textContent='Link clicks: '+e.clicks+(e.sessions>1?' in '+e.sessions+' sessions':'');body.append(click);}detailDialog.showModal();};
  badge.addEventListener('click',open);badge.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}if(event.key==='Escape')badge.blur();});
});
document.getElementById('details-close').addEventListener('click',()=>detailDialog.close());
detailDialog.addEventListener('click',event=>{if(event.target===detailDialog){const r=detailDialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)detailDialog.close();}});
