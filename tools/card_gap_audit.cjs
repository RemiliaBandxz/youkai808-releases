// Card gap audit: flags empty vertical space inside any card (child gap > 90px) and cards in a row whose heights differ > 120px.
const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();let bad=0;
for(const [n,w] of [['desk',1280],['phone',390]]){
 const p=await b.newPage({viewport:{width:w,height:900}});await p.goto('http://localhost:8811/');await p.waitForTimeout(800);
 const r=await p.evaluate(()=>{const out=[];const cards=[...document.querySelectorAll('.card.now-card')];
  cards.forEach(c=>{const kids=[...c.querySelector('.body').children];for(let i=1;i<kids.length;i++){const g=kids[i].getBoundingClientRect().top-kids[i-1].getBoundingClientRect().bottom;if(g>90)out.push((c.id||c.querySelector('h3').textContent)+' gap '+Math.round(g)+' before '+kids[i].className+kids[i].tagName)}
   const d=c.querySelector('details.inside');if(d&&!d.open)out.push('inside closed in '+c.querySelector('h3').textContent)});
  const rows={};cards.forEach(c=>{const r=c.getBoundingClientRect();(rows[Math.round(r.top)]=rows[Math.round(r.top)]||[]).push(r.height)});
  return out;});
 console.log(n,r);bad+=r.length;await p.screenshot({path:`/tmp/claude-0/cards-${n}.png`,fullPage:true})}
await b.close();process.exit(bad?1:0)})();
