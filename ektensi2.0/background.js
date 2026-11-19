/* EMR Assesmen Monitor - background service worker
   Mengirim data ke Apps Script. Dilakukan di sini (bukan di content.js) agar tidak terkena
   CORS/CSP situs RME, dan agar data yang gagal terkirim diantre lalu dicoba ulang.
   Keamanan: token TIDAK ditanam di kode, diambil dari chrome.storage.local (diisi lewat halaman Opsi). */
importScripts("config.js");

const WEBHOOK_URL = EMR_CONFIG.WEBHOOK_URL;
const TOKEN_CADANGAN = "";            // hanya untuk masa transisi; biarkan kosong bila token sudah diisi lewat Opsi
const QKEY = "emrQueue", TKEY = "apiToken";
const Q_MAKS = 500;                   // maksimum antrean
const Q_UMUR_MS = 3 * 24 * 3600 * 1000;   // data yang gagal terkirim > 3 hari dibuang
const TIMEOUT_MS = 20000;
// hanya field ini yang boleh dikirim ke server (apa pun selain ini dibuang)
const FIELDS = ["Timestamp", "norm", "Tempatlayanan", "WaktuKunjung", "WaktuKlikAssesmenKep", "WaktuInputAssesmenKep",
                "UserPembuat", "WaktuKlikTTV", "WaktuInputTTV", "alasan"];

chrome.alarms.create("emrRetry", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === "emrRetry") flushStale().then(flushQueue); });
chrome.runtime.onStartup.addListener(() => flushStale().then(flushQueue));
chrome.runtime.onInstalled.addListener(async () => { if (!(await getToken())) chrome.runtime.openOptionsPage(); });

async function getToken() {
  const o = await chrome.storage.local.get(TKEY);
  return String(o[TKEY] || TOKEN_CADANGAN || "").trim();
}

// Cadangan: jika tab RME ditutup sebelum data terkirim, kirim data yang "menggantung" > 90 detik.
async function flushStale() {
  const { emrState: S } = await chrome.storage.local.get("emrState");
  const r = S && S.rec;
  if (r && !r.done && Date.now() - r.hb > 90000) {
    r.done = true; S.w = "bg";
    await chrome.storage.local.set({ emrState: S });
    await enqueue(Object.assign({ id: r.id, rid: r.id, alasan: "keluar-bg" }, r.d));   // rid disertakan agar baris yang sama diperbarui
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;                 // hanya dari ekstensi ini sendiri
  if (msg && msg.type === "SEND_ROW" && msg.payload) {
    enqueue(msg.payload).then(ok => reply({ ok }));
    return true; // balasan async
  }
});

function bersih(row) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id || "").slice(0, 100);
  if (!id) return null;
  const o = { id, rid: String(row.rid || row.id || "").slice(0, 80), t: Date.now() };
  FIELDS.forEach(k => { if (row[k] != null) o[k] = String(row[k]).slice(0, 200); });
  return o;
}

async function enqueue(row) {
  const o = bersih(row);
  if (!o) return false;
  const { [QKEY]: q = [] } = await chrome.storage.local.get(QKEY);
  q.push(o);
  await chrome.storage.local.set({ [QKEY]: q.slice(-Q_MAKS) });
  await flushQueue();
  return true;
}

let busy = false;
async function flushQueue() {
  if (busy) return;
  busy = true;
  try {
    const { [QKEY]: q = [] } = await chrome.storage.local.get(QKEY);
    if (!q.length) return;
    const selesai = new Set();
    for (const row of q) {
      try {
        const hasil = await kirim(row);          // "ok" atau "drop" (ditolak permanen: data tidak valid)
        selesai.add(row.id);
        if (hasil === "drop") console.warn("[EMR] data ditolak server (tidak valid), dibuang");
      } catch (e) {
        console.warn("[EMR] gagal kirim, akan dicoba lagi:", e.message);
        if (/token belum/.test(e.message)) break;   // tanpa token, percuma mencoba sisanya
      }
    }
    const now = Date.now();
    const { [QKEY]: cur = [] } = await chrome.storage.local.get(QKEY);
    await chrome.storage.local.set({ [QKEY]: cur.filter(r => !selesai.has(r.id) && now - (r.t || now) < Q_UMUR_MS).slice(-Q_MAKS) });
  } finally { busy = false; }
}

async function kirim(row) {
  const token = await getToken();
  if (!token) throw new Error("token belum diatur (buka Opsi ekstensi)");
  const { t, ...payload } = row;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    // text/plain agar tidak memicu preflight (Apps Script tidak menangani OPTIONS)
    res = await fetch(WEBHOOK_URL, {
      method: "POST", credentials: "omit", signal: ctl.signal,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({}, payload, { token }))
    });
  } finally { clearTimeout(to); }
  let j;
  try { j = await res.json(); } catch (e) { throw new Error("respon bukan JSON (HTTP " + res.status + ")"); }
  if (j.status === "success") return "ok";
  if (j.code === "invalid") return "drop";
  throw new Error(j.message || j.code || "respon tidak sukses");
}
