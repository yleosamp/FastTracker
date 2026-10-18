/* Optional public metadata only. Never downloads, installs or touches a project. */
(function () {
  "use strict";
  try {
    var req = window.cep_node ? window.cep_node.require : null;
    if (!req) return;
    var fs = req("fs"), path = req("path"), os = req("os");
    var root = decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, "$1");
    root = path.dirname(root);
    var U = req(path.join(root, "updates.cjs"));
    var version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    var cache = path.join(os.tmpdir(), "fasttracker-updates.json");
    var link = document.getElementById("update-available"), check = document.getElementById("check-updates");
    var checker = new U.UpdateChecker({ version: version, fetch: function (url, options) { return window.fetch(url, options); },
      io: { readJSON: async function () { return JSON.parse(fs.readFileSync(cache, "utf8")); },
        writeJSON: async function (_, value) { fs.writeFileSync(cache, JSON.stringify(value), "utf8"); } } });
    async function refresh(force) {
      check.disabled = true;
      try {
        var state = await checker.check({ force: force });
        link.hidden = !state.available;
        link.title = state.available ? "FastTracker " + state.release.version + " disponível no GitHub" : "";
        check.title = state.error ? "Sem conexão. Clique para tentar novamente." : state.available ? "Nova versão disponível" : "Você está na versão mais recente. Clique para verificar novamente.";
      } catch (_) { /* Optional checker never interrupts tracking. */ }
      finally { check.disabled = false; }
    }
    link.onclick = function () {
      var release = checker.state.release;
      if (!release || U.releaseURL(release.tag) !== release.url) return;
      if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) window.cep.util.openURLInDefaultBrowser(release.url);
    };
    check.onclick = function () { refresh(true); };
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(false); });
    refresh(false);
  } catch (_) { /* Missing runtime, network or cache never blocks the panel. */ }
}());
