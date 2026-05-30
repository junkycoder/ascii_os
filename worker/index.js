// acii_os — edge worker.
//
// For now this just hands every request to the static ASSETS binding, which
// serves the zero-build vanilla ES-module shell (index.html + src/*). The DB
// and any server logic will hang off /api/* here later (D1 binding arrives via
// wrangler.jsonc → env.DB), so the static site keeps working unchanged.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Future API surface, e.g.:
    //   if (url.pathname.startsWith('/api/')) return handleApi(request, env);

    return env.ASSETS.fetch(request);
  },
};
