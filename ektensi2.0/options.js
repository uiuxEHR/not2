const KEY = "apiToken", $ = id => document.getElementById(id);
function say(msg, cls) { const s = $("st"); s.textContent = msg; s.className = cls || ""; }
async function load() {
  const o = await chrome.storage.local.get(KEY), t = o[KEY] || "";
  say(t ? "Token tersimpan (berakhiran …" + t.slice(-4) + ")." : "Token belum diatur.", t ? "ok" : "bad");
}
$("save").onclick = async () => {
  const t = $("tk").value.trim();
  if (!/^[\x21-\x7E]{16,200}$/.test(t)) { say("Format token tidak valid.", "bad"); return; }
  await chrome.storage.local.set({ [KEY]: t });
  $("tk").value = ""; await load();
};
$("clear").onclick = async () => { await chrome.storage.local.remove(KEY); $("tk").value = ""; await load(); };
// Tes: kirim permintaan kosong. Token benar -> server menjawab "data tidak valid"; token salah -> "unauthorized".
$("test").onclick = async () => {
  const o = await chrome.storage.local.get(KEY), token = o[KEY] || "";
  if (!token) { say("Simpan token dulu.", "bad"); return; }
  say("Menguji…");
  try {
    const res = await fetch(EMR_CONFIG.WEBHOOK_URL, { method: "POST", credentials: "omit", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ token }) });
    const j = await res.json();
    if (j.code === "invalid") say("Koneksi dan token VALID.", "ok");
    else if (j.code === "unauthorized" || j.code === "setup") say("Token ditolak server. Minta token baru ke administrator.", "bad");
    else say("Respon tak terduga: " + (j.message || j.code || res.status), "bad");
  } catch (e) { say("Tidak dapat terhubung ke server.", "bad"); }
};
load();
