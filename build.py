# Run before every release: stamps sw.js with a hash of the site files so caches roll over automatically
import hashlib,pathlib
d=pathlib.Path(__file__).parent;h=hashlib.sha256()
for f in ["index.html","app.js","data.js","manifest.webmanifest"]:h.update((d/f).read_bytes())
(d/"sw.js").write_text((d/"sw.template.js").read_text().replace("__BUILD__","pv-"+h.hexdigest()[:10]))
print("sw.js version pv-"+h.hexdigest()[:10])
