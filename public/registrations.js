async function getJSON(url){
  const r = await fetch(url);
  const j = await r.json();
  if(!r.ok) throw new Error(j?.error || "Request failed");
  return j;
}

async function fillFilters(){
  const meta = await getJSON("/api/meta");
  const c = document.getElementById("campaign");
  const g = document.getElementById("game");
  c.innerHTML = `<option value="">All</option>` + meta.campaigns.map(x=>`<option value="${x}">${x}</option>`).join("");
  g.innerHTML = `<option value="">All</option>` + meta.games.map(x=>`<option value="${x}">${x}</option>`).join("");
}

async function load(){
  await fillFilters();

  async function render(){
    const campaign = document.getElementById("campaign").value;
    const game = document.getElementById("game").value;
    const q = document.getElementById("q").value;
    const qs = new URLSearchParams({ ...(q?{q}:{}) , ...(campaign?{campaign_id:campaign}:{}) , ...(game?{game_id:game}:{}) });
    const data = await getJSON(`/api/registrations?${qs.toString()}`);
    const rows = data.rows || [];
    document.getElementById("table").innerHTML = `
      <table class="table">
        <thead><tr>
          <th>Date</th><th>Campaign</th><th>Game</th><th>Name</th><th>Email</th><th>Phone</th><th>Score</th><th>Duration</th>
        </tr></thead>
        <tbody>
          ${rows.map(r=>`
            <tr>
              <td>${new Date(r.created_at).toLocaleString()}</td>
              <td>${r.campaign_id ?? "-"}</td>
              <td>${r.game_id ?? "-"}</td>
              <td>${r.name}</td>
              <td>${r.email}</td>
              <td>${r.phone}</td>
              <td>${r.score ?? "-"}</td>
              <td>${r.duration_ms ? Math.round(r.duration_ms/1000)+"s" : "-"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div class="muted">Showing ${rows.length} rows</div>
    `;
  }

  document.getElementById("apply").addEventListener("click", render);
  document.getElementById("q").addEventListener("keydown", (e)=>{ if(e.key==="Enter") render(); });
  render();
}

load().catch(err => {
  document.body.innerHTML = `<pre style="padding:16px;">${err.message}</pre>`;
});
