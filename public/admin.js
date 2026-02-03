async function getJSON(url){
  const r = await fetch(url);
  const j = await r.json();
  if(!r.ok) throw new Error(j?.error || "Request failed");
  return j;
}

function funnelSVG(steps){
  const w=900, h=220;
  const topW=820, bottomW=240;
  const n=steps.length;
  const segH=h/n;

  const pts=[];
  for(let i=0;i<=n;i++){
    const t=i/n;
    const width=topW*(1-t)+bottomW*t;
    const y=i*segH;
    const x0=(w-width)/2;
    const x1=x0+width;
    pts.push({y,x0,x1});
  }
  let d="";
  for(let i=0;i<n;i++){
    const p0=pts[i], p1=pts[i+1];
    d += `M ${p0.x0} ${p0.y} L ${p0.x1} ${p0.y} L ${p1.x1} ${p1.y} L ${p1.x0} ${p1.y} Z `;
  }
  const labels = steps.map((s,i)=>{
    const y=(i+0.5)*segH;
    return `<text x="24" y="${y}" font-size="20" fill="rgba(17,17,17,.75)">${s.label}: ${s.value}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" fill="rgba(47,212,162,.75)"></path>${labels}</svg>`;
}

async function fillFilters(){
  const meta = await getJSON("/api/meta");
  const bannersResp = await getJSON("/api/banners");

  const c = document.getElementById("campaign");
  const b = document.getElementById("banner");

  c.innerHTML = `<option value="">All</option>` + (meta.campaigns||[]).map(x=>`<option value="${x}">${x}</option>`).join("");

  const banners = (bannersResp.rows || []).slice().reverse(); // oldest->newest not important; reverse for nicer order if needed
  b.innerHTML = `<option value="">All</option>` + banners.map(x=>`<option value="${encodeURIComponent(x.url)}">${x.name}</option>`).join("");
  window.__banners = banners;
}

async function load(){
  await fillFilters();

  async function render(){
    try {
    const days = document.getElementById("days").value;
    const campaign = document.getElementById("campaign").value;
    const banner = document.getElementById("banner").value;
    const qs = new URLSearchParams({ days, ...(campaign?{campaign_id:campaign}:{}) , ...(banner?{banner_url: decodeURIComponent(banner)}:{}) });
    const stats = await getJSON(`/api/stats?${qs.toString()}`);

    document.getElementById("kpis").innerHTML = `
      <div class="kpi"><div class="label">Views</div><div class="value">${stats.totals.views.toLocaleString()}</div></div>
      <div class="kpi"><div class="label">Clicks</div><div class="value">${(stats.totals.clicks||0).toLocaleString()}</div></div>
      <div class="kpi"><div class="label">Starts</div><div class="value">${stats.totals.starts.toLocaleString()}</div></div>
      <div class="kpi"><div class="label">Wins</div><div class="value">${stats.totals.wins.toLocaleString()}</div></div>
      <div class="kpi"><div class="label">Registrations</div><div class="value">${stats.totals.regs.toLocaleString()}</div></div>
    `;

    document.getElementById("funnel").innerHTML = funnelSVG(stats.funnel);
    document.getElementById("rates").textContent =
      `Win: ${(stats.rates.winRate*100).toFixed(1)}% · Reg/Starts: ${(stats.rates.regRateFromStarts*100).toFixed(1)}% · Reg/Wins: ${(stats.rates.regRateFromWins*100).toFixed(1)}%`;

    const labels = stats.series.map(s => s.date.slice(5));
    const views = stats.series.map(s => s.views);
    const clicks = stats.series.map(s => s.clicks || 0);
    const starts = stats.series.map(s => s.starts);
    const wins = stats.series.map(s => s.wins);
    const regs = stats.series.map(s => s.regs);

    const ctx = document.getElementById("line");
    if (window.__chart) window.__chart.destroy();
    window.__chart = new Chart(ctx, {
      type:"line",
      data:{ labels, datasets:[
        {label:"Views", data:views, tension:.2},
        {label:"Clicks", data:clicks, tension:.2},
        {label:"Starts", data:starts, tension:.2},
        {label:"Wins", data:wins, tension:.2},
        {label:"Registrations", data:regs, tension:.2}
      ]},
      options:{ responsive:true, plugins:{ legend:{ display:true } } }
    });
    } catch (err) {
      console.error(err);
      alert(err?.message || String(err));
    }
  }

  document.getElementById("apply").addEventListener("click", (e)=>{ e.preventDefault(); render(); });
  // Optional: auto-refresh when filters change
  document.getElementById("campaign").addEventListener("change", render);
  document.getElementById("banner").addEventListener("change", render);
  document.getElementById("days").addEventListener("change", render);
  render();
}

load().catch(err => {
  document.body.innerHTML = `<pre style="padding:16px;">${err.message}</pre>`;
});


// ----- Banner management modal -----
async function refreshBannerList(){
  const data = await getJSON("/api/banners");
  const list = document.getElementById("bannerList");
  const rows = data.rows || [];
  list.innerHTML = rows.length ? rows.map(r=>`
    <div class="banner-row">
      <div class="left">
        <div class="name">${r.name}</div>
        <div class="url">${r.url}</div>
      </div>
      <button class="ghost" data-del="${r.id}">Delete</button>
    </div>
  `).join("") : `<div class="muted">No banners added yet.</div>`;

  list.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      await fetch(`/api/banners/${id}`, { method:"DELETE" });
      await fillFilters();
      await refreshBannerList();
    });
  });
}

function openBannerModal(){
  document.getElementById("bannerModal").classList.remove("hidden");
  refreshBannerList().catch(()=>{});
}
function closeBannerModal(){
  document.getElementById("bannerModal").classList.add("hidden");
}

document.getElementById("manageBanners").addEventListener("click", openBannerModal);
document.getElementById("closeBannerModal").addEventListener("click", closeBannerModal);
document.getElementById("bannerModal").addEventListener("click", (e)=>{ if(e.target.id==="bannerModal") closeBannerModal(); });

document.getElementById("bannerForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const name = document.getElementById("bannerName").value.trim();
  const url = document.getElementById("bannerUrl").value.trim();
  if (!name || !url) return;
  await fetch("/api/banners", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ name, url })
  });
  document.getElementById("bannerName").value="";
  document.getElementById("bannerUrl").value="";
  await fillFilters();
  await refreshBannerList();
});
